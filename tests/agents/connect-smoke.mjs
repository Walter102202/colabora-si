// Fresh-account OAuth + MCP integration. Local only; never prints credentials or response bodies.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { cancelConsent, connectAgent, connectWorkspaces } from "../../lib/agentConsent.ts";
import { readMessages } from "../../bridge/remote.mjs";

const parseEnv = (text) => Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  return match ? [[match[1], match[2].replace(/^"|"$/g, "")]] : [];
}));
const env = parseEnv(readFileSync(new URL("../../.env.local", import.meta.url), "utf8"));
const base = env.VITE_SUPABASE_URL, anon = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!base || !anon || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("This smoke requires a local .env.local URL and public key.");
const local = (url) => { if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("Refusing a nonlocal endpoint"); return url; };
const status = execFileSync(process.platform === "win32" ? "cmd.exe" : "npx",
  process.platform === "win32" ? ["/d", "/s", "/c", "npx supabase status -o env"] : ["supabase", "status", "-o", "env"],
  { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
const service = parseEnv(status).SERVICE_ROLE_KEY;
if (!service) throw new Error("Local service key unavailable");
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(base, service, options), person = createClient(base, anon, options);
const lines = [], logPath = "C:/dev/connect-smoke.log";
let stage = "setup", count = 0;
function check(label, condition) {
  stage = label; const line = `${condition ? "ok" : "FAIL"} ${label}`;
  lines.push(line); console.log(line); writeFileSync(logPath, lines.join("\n") + "\n");
  if (!condition) throw new Error(label);
}
async function result(label, promise) { stage = label; const out = await promise; check(label, !out.error); return out.data; }
let ownerId, workspaceId;
try {
  const password = randomBytes(24).toString("base64url"), email = `connect-${randomUUID()}@test.invalid`;
  const created = await result("fresh person created", admin.auth.admin.createUser({ email, password, email_confirm: true }));
  ownerId = created.user.id;
  await result("fresh person signed in", person.auth.signInWithPassword({ email, password }));
  const workspace = await result("workspace created", person.from("workspaces").insert({ name: "Connect smoke", owner_id: ownerId }).select("id").single());
  workspaceId = workspace.id;
  await result("owner bootstrap membership", person.from("workspace_members").insert({ workspace_id: workspaceId, user_id: ownerId, role: "owner" }));
  const countAgents = async () => (await result("read agent count", person.from("agents").select("id").eq("workspace_id", workspaceId).eq("is_platform", false))).length;
  check("workspace starts without external agents", await countAgents() === 0);
  const spaces = await connectWorkspaces(person); check("connectWorkspaces lists own workspace", spaces.some((row) => row.id === workspaceId));
  const metadataResponse = await fetch(`${base}/auth/v1/.well-known/oauth-authorization-server`);
  check("OAuth metadata available", metadataResponse.ok);
  const metadata = await metadataResponse.json();
  for (const key of ["registration_endpoint", "authorization_endpoint", "token_endpoint"]) local(metadata[key]);
  async function authorize() {
    const redirect = "http://127.0.0.1:9/connect-callback";
    const registration = await fetch(metadata.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Connect smoke", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    check("dynamic client registration", registration.ok);
    const clientId = (await registration.json()).client_id, verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "local-smoke", scope: "email" });
    const response = await fetch(`${metadata.authorization_endpoint}?${query}`, { redirect: "manual" });
    const location = new URL(local(response.headers.get("location")));
    check("authorization reaches consent", location.pathname === "/oauth/consent" && Boolean(location.searchParams.get("authorization_id")));
    return { id: location.searchParams.get("authorization_id"), clientId, verifier, redirect };
  }
  const cancelled = await authorize();
  const cancelUrl = await cancelConsent(person, cancelled.id, cancelled.clientId);
  check("cancel returns denial", new URL(cancelUrl).searchParams.get("error") === "access_denied");
  check("cancel creates no agent", await countAgents() === 0);
  const pagesAfterCancel = await result("read pages after cancel", person.from("pages").select("id").eq("workspace_id", workspaceId));
  check("cancel creates no page", pagesAfterCancel.length === 0);

  const flow = await authorize(), input = { authorizationId: flow.id, workspaceId, name: "Connect smoke", role: "worker" };
  stage = "connectAgent initial approval"; await connectAgent(person, input);
  check("approval creates one agent", await countAgents() === 1);
  stage = "connectAgent idempotent retry"; const returnUrl = await connectAgent(person, input);
  check("same authorization reuses the agent", await countAgents() === 1);
  const tokenResponse = await fetch(metadata.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
    grant_type: "authorization_code", code: new URL(returnUrl).searchParams.get("code"), redirect_uri: flow.redirect, client_id: flow.clientId, code_verifier: flow.verifier }) });
  const tokenResult = await tokenResponse.json(); check("PKCE code exchange", tokenResponse.ok && typeof tokenResult.access_token === "string");
  const token = tokenResult.access_token;
  check("OAuth token represents an agent", JSON.parse(Buffer.from(token.split(".")[1], "base64url")).app_metadata?.principal_type === "agent");
  const connection = await result("read saved connection", person.from("agent_connections").select("*").eq("workspace_id", workspaceId).single());
  check("approval does not set verified_at", connection.verified_at === null && Boolean(connection.approved_at));
  const privatePage = await result("owner private-page fixture", person.rpc("create_page", { p_input: { workspace_id: workspaceId, title: "Private owner note" }, p_idempotency_key: randomUUID() }));
  await result("private-page boundary fixture", admin.from("private_pages").insert({ page_id: privatePage.id, workspace_id: workspaceId, owner_user_id: ownerId, root_page_id: privatePage.id }));

  const sessions = new Map();
  async function mcp(bearer, method, params = {}) {
    const response = await fetch(`${base}/functions/v1/workspace-mcp`, { method: "POST", headers: {
      Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18",
      ...(sessions.has(bearer) ? { "Mcp-Session-Id": sessions.get(bearer) } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", id: ++count, method, params }) });
    if (response.headers.has("mcp-session-id")) sessions.set(bearer, response.headers.get("mcp-session-id"));
    if (!response.ok) return { denied: true, status: response.status };
    const message = (await readMessages(response))[0];
    return message?.error ? { denied: true } : message?.result;
  }
  const call = (bearer, name, args) => mcp(bearer, "tools/call", { name, arguments: args });
  const initialize = (bearer) => mcp(bearer, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "connect-smoke", version: "1" } });
  check("workspace MCP initializes", Boolean((await initialize(token))?.serverInfo));
  check("workspace MCP lists tools", (await mcp(token, "tools/list"))?.tools?.some((tool) => tool.name === "read_page"));
  const listed = (await call(token, "list_pages", {}))?.structuredContent?.pages;
  check("only starter page is visible", listed?.length === 1 && listed[0].id === connection.page_id);
  check("private owner page stays hidden", !listed?.some((page) => page.id === privatePage.id));
  const read = await call(token, "read_page", { page_id: connection.page_id });
  check("agent reads Getting started", read?.structuredContent?.title === "Getting started");
  const verified = await result("read verification timestamp", person.from("agent_connections").select("verified_at").eq("agent_id", connection.agent_id).single());
  check("real page read verifies connection", Boolean(verified.verified_at));
  const child = await call(token, "create_page", { parent_id: connection.page_id, title: "Our first plan", idempotency_key: randomUUID() });
  check("agent creates a child page", typeof child?.structuredContent?.id === "string");
  const root = await call(token, "create_page", { workspace_id: workspaceId, title: "Forbidden root", idempotency_key: randomUUID() });
  check("agent cannot create a root page", root?.isError === true || root?.denied === true);
  const own = await result("own agent created", person.functions.invoke("agent-admin", { body: { action: "connect_own_agent", workspace_id: workspaceId, name: "Own smoke" } }));
  const issued = await result("own token issued", person.rpc("issue_agent_token", { p_agent_id: own.agent_id, p_name: "default" }));
  const exchanged = await fetch(`${base}/functions/v1/agent-token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: issued.token }) });
  const ownAuth = await exchanged.json(); check("own PAT exchanges for an agent token", exchanged.ok && Boolean(ownAuth.access_token));
  await initialize(ownAuth.access_token);
  check("own agent reads starter", (await call(ownAuth.access_token, "read_page", { page_id: own.page_id }))?.structuredContent?.title === "Getting started");
  const ownVerified = await result("read own verification", person.from("agent_connections").select("verified_at").eq("agent_id", own.agent_id).single());
  check("own agent becomes verified", Boolean(ownVerified.verified_at));
  await result("revoke connected agent", person.functions.invoke("agent-admin", { body: { action: "revoke_agent", agent_id: connection.agent_id } }));
  const revoked = await call(token, "read_page", { page_id: connection.page_id });
  check("revocation blocks the next read", revoked?.denied === true || revoked?.isError === true);
  check("connect smoke complete", true);
} catch {
  const line = `FAIL smoke aborted during ${stage}`; lines.push(line); console.error(line); writeFileSync(logPath, lines.join("\n") + "\n"); process.exitCode = 1;
} finally {
  // Disposable local accounts only; no seed user or unrelated workspace is touched.
  if (workspaceId) {
    const { data } = await admin.from("agents").select("auth_user_id").eq("workspace_id", workspaceId);
    for (const agent of data ?? []) await admin.auth.admin.deleteUser(agent.auth_user_id);
    await admin.from("workspaces").delete().eq("id", workspaceId);
  }
  if (ownerId) await admin.auth.admin.deleteUser(ownerId);
}
