#!/usr/bin/env node
// Smoke test of the remote MCP server against a running stack (`supabase functions serve mcp`).
// Not part of the unit suites: it needs a database, an agent and a personal access token.
//
//   MCP_URL=http://127.0.0.1:54321/functions/v1/mcp \
//   AGENT_PAT=agt_... \
//   SMOKE_PAGE_ID=<page the agent can write> \
//   [AGENT_TOKEN_URL=http://127.0.0.1:54321/functions/v1/agent-token] \
//   [SMOKE_TASK_ID=<queued task delegated to the agent>] \
//   node tests/agents/mcp-smoke.mjs
//
// Page steps: tools/list, read_page, append_blocks, edit_page with a stale rev -> block_conflict with the current text.
// Task steps (when SMOKE_TASK_ID is set): claim_task -> post_activity -> add_artifact -> submit_for_review.

const env = process.env;
const missing = ["MCP_URL", "AGENT_PAT", "SMOKE_PAGE_ID"].filter((name) => !env[name]);
if (missing.length) {
  console.error(`mcp-smoke: set ${missing.join(", ")} to run against a served mcp function (see the header of this file).`);
  process.exit(2);
}

const MCP_URL = env.MCP_URL;
const TOKEN_URL = env.AGENT_TOKEN_URL || new URL("/functions/v1/agent-token", MCP_URL).toString();
let nextId = 1;
let jwt = "";

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

async function exchange() {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: env.AGENT_PAT }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`agent-token ${res.status}: ${JSON.stringify(body)}`);
  jwt = body.access_token;
  check(typeof jwt === "string" && jwt.split(".").length === 3, "PAT exchanged for an access token");
}

async function rpc(method, params = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${jwt}`,
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  return { isError: result.isError === true, data: result.structuredContent ?? {} };
}

async function ok(name, args) {
  const { isError, data } = await tool(name, args);
  if (isError) throw new Error(`${name} failed: ${JSON.stringify(data)}`);
  return data;
}

async function pageSteps() {
  const pageId = env.SMOKE_PAGE_ID;
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-smoke", version: "1" } });
  check(typeof init.instructions === "string" && init.instructions.length > 0, "initialize returns instructions");
  const { tools } = await rpc("tools/list");
  const names = new Set(tools.map((t) => t.name));
  check(["read_page", "append_blocks", "edit_page", "search", "query_database"].every((n) => names.has(n)), "tools/list has the page tools");

  const read = await ok("read_page", { page_id: pageId });
  check(typeof read.markdown === "string", `read_page returns Markdown (revision ${read.revision})`);

  const marker = `smoke ${Date.now()}`;
  const appended = await ok("append_blocks", { page_id: pageId, markdown: `${marker} first` });
  check(appended.block_ids.length === 1, "append_blocks inserts one block");
  const blockId = appended.block_ids[0];

  const reread = await ok("read_page", { page_id: pageId, max_blocks: 500 });
  const block = reread.blocks.find((b) => b.id === blockId);
  check(block && typeof block.rev === "number", "the new block has a rev");

  await ok("edit_page", { page_id: pageId, block_id: blockId, old_str: "first", new_str: "second", rev: block.rev });
  const conflict = await tool("edit_page", { page_id: pageId, block_id: blockId, old_str: "first", new_str: "third", rev: block.rev });
  check(conflict.isError && conflict.data.code === "block_conflict", "a stale rev returns block_conflict");
  check(String(conflict.data.detail?.text ?? "").includes(`${marker} second`), "the conflict carries the current text");
}

async function taskSteps() {
  if (!env.SMOKE_TASK_ID) {
    console.log("skip - task steps (set SMOKE_TASK_ID)");
    return;
  }
  const taskId = env.SMOKE_TASK_ID;
  const waited = await ok("wait_for_my_tasks", {});
  check(typeof waited.next_cursor === "string", "wait_for_my_tasks returns a cursor");

  const claim = await ok("claim_task", { task_id: taskId, harness: "custom", external_session_id: "mcp-smoke" });
  check(claim.task_id === taskId && typeof claim.run_id === "string", `claim_task starts run ${claim.run_id}`);
  const runId = claim.run_id;
  const criteria = (claim.brief?.done_when ?? []).filter((c) => c.check !== "human").map((c) => c.id);

  const activity = await ok("post_activity", { run_id: runId, type: "thought", body: { text: "Smoke test run" } });
  check(typeof activity.seq === "number", `post_activity logged #${activity.seq}`);

  const artifact = await ok("add_artifact", {
    run_id: runId, kind: "page", ref: claim.row_page_id, title: "Smoke deliverable", satisfies: criteria,
  });
  check(typeof artifact.artifact_id === "string", `add_artifact declared v${artifact.version}`);

  const quick = await ok("wait_for_task", { task_id: taskId, after_seq: activity.seq, timeout_s: 0, run_id: runId });
  check(typeof quick.next_seq === "number", "wait_for_task with timeout_s 0 returns at once");

  const submitted = await ok("submit_for_review", { run_id: runId, summary: "Smoke test delivery", artifact_ids: [artifact.artifact_id] });
  check(submitted.task_state === "ready_for_review", "submit_for_review moves the task to ready_for_review");
}

try {
  await exchange();
  await pageSteps();
  await taskSteps();
  console.log("mcp-smoke: all checks passed");
} catch (error) {
  console.error(`mcp-smoke: FAILED - ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
