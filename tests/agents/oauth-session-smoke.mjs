// Smoke test of chat connections against a served local stack: the OAuth flow a chat app follows, a link to an agent,
// and the session hook seen through the real Data API. Not part of npm test, like mcp-smoke.mjs.
// Needs API_URL, ANON_KEY, SERVICE_ROLE_KEY, SMOKE_PASSWORD (the seed password of owner@demo.local).
// Optional: MCP_URL, to also ask the served mcp function who the linked session is.
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const { API_URL: base, ANON_KEY: anon, SERVICE_ROLE_KEY: service, SMOKE_PASSWORD: password, MCP_URL: mcpUrl } = process.env;
if (!base || !anon || !service || !password) {
  console.error("Set API_URL, ANON_KEY, SERVICE_ROLE_KEY and SMOKE_PASSWORD.");
  process.exit(2);
}

let failed = 0;
const check = (label, ok, got) => {
  console.log(`${ok ? "ok" : "FAIL"} ${label}${ok ? "" : ` (${JSON.stringify(got)})`}`);
  if (!ok) failed += 1;
};
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const redirect = "http://127.0.0.1:9/cb";
const meta = await (await fetch(`${base}/auth/v1/.well-known/oauth-authorization-server`)).json();
const person = createClient(base, anon, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: signedIn, error: signInError } = await person.auth.signInWithPassword({ email: "owner@demo.local", password });
if (signInError) throw signInError;

async function authorize(name) {
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  const client = await res.json();
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash("sha256").update(verifier).digest());
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "smoke", scope: "email" });
  const start = await fetch(`${meta.authorization_endpoint}?${query}`, { redirect: "manual" });
  const location = new URL(start.headers.get("location"));
  check(`${name}: authorize lands on the consent path`, location.pathname === "/oauth/consent", location.pathname);
  return { clientId: client.client_id, verifier, id: location.searchParams.get("authorization_id") };
}

async function connect(name) {
  const flow = await authorize(name);
  // The server binds the authorization to the person on this read; approving without it answers 404.
  const { data: details, error } = await person.auth.oauth.getAuthorizationDetails(flow.id);
  if (error) throw error;
  check(`${name}: details name the client`, details.client?.id === flow.clientId && details.client?.name === name, details.client);
  const { data: approved, error: approveError } = await person.auth.oauth.approveAuthorization(flow.id, { skipBrowserRedirect: true });
  if (approveError) throw approveError;
  const code = new URL(approved.redirect_url).searchParams.get("code");
  const token = await (await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: flow.clientId, code_verifier: flow.verifier }),
  })).json();
  return { clientId: flow.clientId, token: token.access_token };
}

const rest = async (key, token, path, body) => {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "count=exact" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, total: Number((res.headers.get("content-range") ?? "/0").split("/")[1]), json };
};

// Every role passes the hook. A missing grant here breaks reminders and dispatch, not only chats.
check("service role reaches the Data API", (await rest(service, service, "agents?select=id&limit=1")).status < 300, null);
check("anonymous reaches the Data API", (await rest(anon, anon, "rpc/session_identity", {})).status !== 500, null);

// Deny answers the app with access_denied.
{
  const flow = await authorize("Smoke denied");
  await person.auth.oauth.getAuthorizationDetails(flow.id);
  const { data, error } = await person.auth.oauth.denyAuthorization(flow.id, { skipBrowserRedirect: true });
  check("deny answers access_denied", !error && data.redirect_url.includes("error=access_denied"), error?.message);
}

const owner = signedIn.session.access_token;
const plain = await connect("Smoke as you");
const asPerson = await rest(anon, plain.token, "rpc/session_identity", {});
check("an unlinked chat is the person", asPerson.json?.principal_type === "human" && asPerson.json?.user_id === signedIn.user.id, asPerson);

const linked = await connect("Smoke as agent");
const agents = await rest(anon, owner, "rpc/linkable_agents", {});
const agent = agents.json.find((a) => /codex/i.test(a.name));
check("the owner can pick an agent", Boolean(agent), agents.json);
await rest(anon, owner, "rpc/set_oauth_link", { p_client_id: linked.clientId, p_agent_id: agent.id });
const asAgent = await rest(anon, linked.token, "rpc/session_identity", {});
check("a linked chat is the agent", asAgent.json?.principal_type === "agent" && asAgent.json?.agent_id === agent.id, asAgent);
check("via keeps the person", asAgent.json?.via_user === signedIn.user.id, asAgent);
const seenByPerson = await rest(anon, owner, "pages?select=id&limit=1");
const seenByAgent = await rest(anon, linked.token, "pages?select=id&limit=1");
check("the agent sees fewer pages than the person", seenByAgent.total < seenByPerson.total, [seenByAgent.total, seenByPerson.total]);
const ops = await rest(anon, linked.token, "rpc/apply_page_ops", { p_page_id: "x", p_ops: [] });
check("the whole-ops entry is closed", ops.status === 403 && ops.json?.message === "use_partial_writes", ops);
const close = await rest(anon, linked.token, "rpc/close_task", { p_task_id: "00000000-0000-0000-0000-000000000000", p_acceptance: "accepted" });
check("it cannot accept work", close.status === 403 && close.json?.message === "humans_only", close);
const selfLink = await rest(anon, linked.token, "rpc/set_oauth_link", { p_client_id: linked.clientId, p_agent_id: null });
check("it cannot remove its own link", selfLink.status === 403, selfLink);

if (mcpUrl) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${linked.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_my_tasks", arguments: {} } }),
  });
  check("the mcp function accepts the linked chat", res.status === 200, res.status);
}

await rest(anon, owner, "rpc/revoke_oauth_link", { p_client_id: linked.clientId });
const revoked = await rest(anon, linked.token, "rpc/session_identity", {});
check("a disconnected chat is refused at once", revoked.status === 401, revoked);
const stillPerson = await rest(anon, owner, "rpc/session_identity", {});
check("the person's own session is untouched", stillPerson.status === 200, stillPerson);

// The link stays revoked in the seed database otherwise; a reset is not assumed between runs.
await rest(anon, owner, "rpc/set_oauth_link", { p_client_id: linked.clientId, p_agent_id: null });

console.log(failed ? `${failed} failed` : "all ok");
process.exit(failed ? 1 : 0);
