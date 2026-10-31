// Local runtime smoke; also provides the same safe local client to the real-model check.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createRemote } from "../../bridge/remote.mjs";

export const base = "http://127.0.0.1:60990";
export const endpoint = `${base}/functions/v1/workspace-mcp`;
export function localClient() {
  const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
  assert.match(config, /project_id = "colabora-si-p14"/);
  assert.match(config, /port = 60990/);
  const seed = readFileSync(new URL("../../supabase/seeds/02_agents.sql", import.meta.url), "utf8");
  const pat = seed.match(/'(agt_LOCALDEVCODEX[0-9]+)'/)?.[1];
  assert.ok(pat);
  return createRemote({ mcpUrl: endpoint, pat, clientInfo: { name: "p14-local-smoke", version: "1" } });
}
export async function discover(client) {
  const { messages } = await client.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p14", version: "1" } } });
  assert.ok(messages[0].result, "initialize succeeds");
  const listed = await client.call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return { tools: listed.messages[0].result.tools, instructions: messages[0].result.instructions };
}
export async function smoke() {
  const unauth = await fetch(endpoint, { method: "POST", body: "{}" });
  assert.equal(unauth.status, 401);
  assert.ok(unauth.headers.get("www-authenticate")?.includes("workspace-mcp/.well-known"));
  const metadata = await (await fetch(`${endpoint}/.well-known/oauth-protected-resource`)).json();
  assert.equal(metadata.resource, endpoint);
  const client = localClient();
  const { tools, instructions } = await discover(client);
  assert.equal(tools.length, 23); assert.ok(instructions.length <= 800);
  const run = randomUUID();
  const call = (name, args) => client.callTool(name, { ...args, idempotency_key: `${run}:${name}` });
  const page = await call("create_page", { parent_id: "market-research", title: "P14 runtime page", markdown: "# Runtime proof\n\nCreated by the local agent.\n\n## Next steps\n\n- Verify live sync" });
  assert.deepEqual(await call("create_page", { parent_id: "market-research", title: "P14 runtime page" }), page);
  const db = await call("create_database", { parent_id: "market-research", title: "P14 runtime CRM", properties: [{ name: "Stage", type: "select" }],
    views: [{ name: "Table", type: "table" }, { name: "Board", type: "board", group_by: "Stage" }],
    rows: ["Acme", "Birch", "Cedar", "Delta", "Elm"].map(name => ({ cells: { Name: { text: name }, Stage: { select: "New" } } })) });
  const schema = await client.callTool("query_database", { database_id: db.id, limit: 0 });
  assert.equal(schema.rows.length, 0); assert.equal(schema.views.length, 2);
  assert.equal(schema.properties.find(p => p.name === "Stage").options[0].name, "New");
  const moved = await call("move_page", { page_id: page.id, parent_id: db.id });
  assert.equal(moved.previous_parent_id, "market-research");
  await call("archive_page", { page_id: page.id });
  await call("restore_page", { page_id: page.id });
  const evidence = { page, database: db, toolCount: tools.length, instructionsLength: instructions.length, passed: true };
  writeFileSync(new URL("../../.local/runtime-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await smoke();
