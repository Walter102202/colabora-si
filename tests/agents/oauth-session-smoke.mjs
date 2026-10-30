// Real local Auth, Data API, Storage, Realtime and Edge-runtime checks. Never run against a hosted project.
// Needs API_URL, ANON_KEY, SERVICE_ROLE_KEY, SMOKE_PASSWORD; MCP_URL enables the served MCP assertion.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { approveConsent, connectedApps, denyConsent, disconnectApp, loadConsent } from "../../lib/agentConsent.ts";

const { API_URL: base, ANON_KEY: anon, SERVICE_ROLE_KEY: service, SMOKE_PASSWORD: password, MCP_URL: mcpUrl } = process.env;
if (!base || !anon || !service || !password) throw new Error("Set API_URL, ANON_KEY, SERVICE_ROLE_KEY and SMOKE_PASSWORD.");
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("This smoke only runs locally.");
let failed = 0;
const check = (label, ok, got) => { console.log(`${ok ? "ok" : "FAIL"} ${label}${ok ? "" : ` (${JSON.stringify(got)})`}`); if (!ok) failed++; };
const person = createClient(base, anon, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: signedIn, error: signInError } = await person.auth.signInWithPassword({ email: "owner@demo.local", password });
if (signInError) throw signInError;
const owner = signedIn.session.access_token;
const meta = await (await fetch(`${base}/auth/v1/.well-known/oauth-authorization-server`)).json();
const claims = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
async function raw(method, path, token, body, key = anon, extra = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "count=exact", ...extra },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, total: Number((res.headers.get("content-range") ?? "/0").split("/")[1]) };
}
const rpc = (token, name, args = {}) => raw("POST", `/rest/v1/rpc/${name}`, token, args);
async function authorize(name, redirect = "http://127.0.0.1:9/cb", clientId) {
  if (!clientId) {
    const registered = await fetch(meta.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    clientId = (await registered.json()).client_id;
  }
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "smoke", scope: "email" });
  const start = await fetch(`${meta.authorization_endpoint}?${query}`, { redirect: "manual" });
  const location = new URL(start.headers.get("location"));
  check(`${name}: authorize lands on the consent path`, location.pathname === "/oauth/consent", location.pathname);
  return { clientId, verifier, id: location.searchParams.get("authorization_id"), redirect };
}
async function exchange(flow, url) {
  const res = await fetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
    grant_type: "authorization_code", code: new URL(url).searchParams.get("code"), redirect_uri: flow.redirect, client_id: flow.clientId, code_verifier: flow.verifier }) });
  const result = await res.json(); if (!result.access_token) throw new Error(`OAuth exchange failed: ${JSON.stringify(result)}`);
  return result.access_token;
}
async function connect(name, agentId, redirect, clientId, client = person) {
  const flow = await authorize(name, redirect, clientId);
  const detail = await loadConsent(client, flow.id, agentId);
  const url = detail.kind === "redirect" ? detail.url : await approveConsent(client, flow.id, flow.clientId, agentId, detail);
  return { ...flow, token: await exchange(flow, url), remembered: detail.kind === "redirect" };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function watch(token, label) {
  const client = createClient(base, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  await client.realtime.setAuth(token);
  const events = [];
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMED_OUT"), 15000);
    client.channel(`smoke-${label}-${randomUUID()}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pages", filter: "id=eq.market-research" }, (event) => events.push(event))
      .subscribe((state) => {
        if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT"].includes(state)) { clearTimeout(timer); resolve(state); }
      });
  });
  return { label, events, status, close: () => client.removeAllChannels() };
}
check("service role reaches the Data API", (await raw("GET", "/rest/v1/agents?select=id&limit=1", service, undefined, service)).status < 300);
check("anonymous reaches the Data API", (await raw("POST", "/rest/v1/rpc/session_identity", anon, {}, anon)).status !== 500);
const agents = await rpc(owner, "linkable_agents");
const agent = agents.json.find((a) => /codex/i.test(a.name));
check("the owner can pick an agent", Boolean(agent));
const agentRow = await person.from("agents").select("auth_user_id,workspace_id").eq("id", agent.id).single();
if (agentRow.error) throw agentRow.error;
const agentUser = agentRow.data.auth_user_id;
{
  const flow = await authorize("Smoke denied");
  await loadConsent(person, flow.id, agent.id);
  check("deny answers access_denied as the agent", (await denyConsent(person, flow.id, agent.id)).includes("error=access_denied"));
}
{
  const flow = await authorize("Smoke wrong binding");
  await person.auth.oauth.getAuthorizationDetails(flow.id);
  const wrong = await raw("POST", "/functions/v1/agent-admin", owner, { action: "oauth_approve", agent_id: agent.id, authorization_id: flow.id });
  check("a human-read authorization cannot be approved as the agent", wrong.status === 404, wrong);
}
for (const redirect of ["evilapp://claude.ai/cb", "http://localhost:3000/cb"]) {
  const previous = await authorize("Untrusted As you", redirect);
  // Model a grant made before the trusted-host policy: it must not trigger automatic consent now.
  await person.auth.oauth.getAuthorizationDetails(previous.id);
  const previouslyApproved = await person.auth.oauth.approveAuthorization(previous.id, { skipBrowserRedirect: true });
  if (previouslyApproved.error) throw previouslyApproved.error;
  const flow = await authorize("Remembered untrusted As you", redirect, previous.clientId);
  let denied = false;
  try { await loadConsent(person, flow.id, null); } catch (e) { denied = e.message.includes("choosing As an agent"); }
  check(`As you denies remembered consent for ${redirect}`, denied);
}
const plain = await connect("Smoke as you", null, "https://claude.ai/oauth/cb");
const asPerson = await rpc(plain.token, "session_identity");
check("an explicit trusted As-you chat is the person", asPerson.json?.principal_type === "human" && asPerson.json?.user_id === signedIn.user.id, asPerson);
const pat = await rpc(plain.token, "issue_agent_token", { p_agent_id: agent.id });
check("As-you chat cannot mint a PAT", pat.status === 403 && pat.json.message === "direct_session_required", pat);
for (const action of ["create_agent", "rotate_login", "enable_platform_agent", "oauth_read"]) {
  const result = await raw("POST", "/functions/v1/agent-admin", plain.token, { action, agent_id: agent.id, workspace_id: agent.workspace_id });
  check(`As-you chat cannot ${action}`, result.status === 403 && result.json.error === "direct_session_required", result);
}
const linked = await connect("Smoke as agent", agent.id);
check("the signed OAuth subject is the agent, never the person", claims(linked.token).sub === agentUser && claims(linked.token).app_metadata?.principal_type === "agent", { sub: claims(linked.token).sub });
const me = await raw("GET", "/auth/v1/user", linked.token);
check("Auth user is the agent", me.status === 200 && me.json.id === agentUser, { status: me.status, id: me.json.id });
const asAgent = await rpc(linked.token, "session_identity");
check("a linked chat is the agent", asAgent.json?.principal_type === "agent" && asAgent.json?.agent_id === agent.id, asAgent);
check("via keeps the person", asAgent.json?.via_user === signedIn.user.id, asAgent);
const seenByPerson = await raw("GET", "/rest/v1/pages?select=id&limit=1", owner);
const seenByAgent = await raw("GET", "/rest/v1/pages?select=id&limit=1", linked.token);
check("the agent sees fewer pages than the person", seenByAgent.total < seenByPerson.total, [seenByAgent.total, seenByPerson.total]);
const ops = await rpc(linked.token, "apply_page_ops", { p_page_id: "x", p_ops: [] });
check("the whole-ops entry is closed", ops.status === 403 && ops.json.message === "use_partial_writes", ops);
const close = await rpc(linked.token, "close_task", { p_task_id: randomUUID(), p_acceptance: "accepted" });
check("it cannot accept work", close.status === 403 && close.json.message === "humans_only", close);
const selfLink = await rpc(linked.token, "set_oauth_link", { p_client_id: linked.clientId, p_agent_id: null });
check("it cannot remove its own link", selfLink.status === 403, selfLink);
const remembered = await connect("Remembered agent", agent.id, linked.redirect, linked.clientId);
check("remembered consent returns a working agent redirect", remembered.remembered && (await rpc(remembered.token, "session_identity")).json.agent_id === agent.id);
const apps = await connectedApps(person);
check("agent app name and destination come from the stored link", apps.some((a) => a.clientId === linked.clientId && a.agentId === agent.id && a.name === "Smoke as agent" && a.redirectHost === linked.redirect));
let second;
{
  const flow = await authorize("Second client minted by chat");
  const read = await raw("GET", `/auth/v1/oauth/authorizations/${flow.id}`, linked.token);
  if (read.status === 200) {
    const approve = await raw("POST", `/auth/v1/oauth/authorizations/${flow.id}/consent`, linked.token, { action: "approve" });
    if (approve.status === 200) {
      second = await exchange(flow, approve.json.redirect_url);
      check("a second client still has only the agent subject", claims(second).sub === agentUser);
      check("a second client without a link is refused by the Data API", (await rpc(second, "session_identity")).status === 401);
    } else check("Auth refuses second-client approval", approve.status >= 400);
  } else check("Auth refuses reading another client", read.status >= 400);
}
const file = `${agent.workspace_id}/${randomUUID()}`;
const upload = await person.storage.from("files").upload(file, "human-private", { contentType: "text/plain" });
if (upload.error) throw upload.error;
check("agent chat cannot download an unattached human file", (await raw("GET", `/storage/v1/object/files/${file}`, linked.token)).status >= 400);
check("agent chat cannot upload as its person", (await raw("POST", `/storage/v1/object/files/${agent.workspace_id}/${randomUUID()}`, linked.token, "x", anon, { "Content-Type": "text/plain" })).status >= 400);
if (mcpUrl) {
  const res = await fetch(mcpUrl, { method: "POST", headers: { Authorization: `Bearer ${linked.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_my_tasks", arguments: {} } }) });
  const body = await res.json();
  check("the mcp function accepts the linked chat", res.status === 200 && body.result?.isError !== true, body.error ?? body.result?.isError);
}
// The chat cannot turn its OAuth token into independently usable credentials.
const changedPassword = `Smoke-${randomUUID()}`;
const changed = await raw("PUT", "/auth/v1/user", linked.token, { password: changedPassword });
check("the chat cannot change the agent password", changed.status >= 400, changed);
const humanLogin = await raw("POST", "/auth/v1/token?grant_type=password", anon, { email: "owner@demo.local", password: changedPassword });
check("the chat cannot log in directly as its person", humanLogin.status >= 400);
const ownLogin = await raw("POST", "/auth/v1/token?grant_type=password", anon, { email: `agent+${agent.id}@agents.invalid`, password: changedPassword });
check("the chat cannot obtain a direct agent session", ownLogin.status >= 400, { status: ownLogin.status });
for (const field of ["email", "phone"]) {
  const result = await raw("PUT", "/auth/v1/user", linked.token, { [field]: field === "email" ? `chat-${randomUUID()}@test.invalid` : "+15555550123" });
  check(`the chat cannot change agent ${field}`, result.status >= 400, { status: result.status });
}
const exchangePat = () => raw("POST", "/functions/v1/agent-token", anon, { token: "agt_LOCALDEVCODEX000000000000000000000000002" });
check("a rejected password change leaves PAT exchange working", (await exchangePat()).status === 200);
const rotated = await person.functions.invoke("agent-admin", { body: { action: "rotate_login", agent_id: agent.id } });
if (rotated.error) throw rotated.error;
check("Rotate login still works with the one-use marker", rotated.data.rotated === true && (await exchangePat()).status === 200);
const control = await connect("Live control after Rotate login", agent.id);

// Use an attached file on a granted page: an unattached human file cannot detect this regression.
const attachedId = randomUUID(), attachedPath = `${agent.workspace_id}/${attachedId}`;
const attached = await person.storage.from("files").upload(attachedPath, "attached-private", { contentType: "text/plain" });
if (attached.error) throw attached.error;
const attach = await rpc(owner, "apply_page_ops", { p_page_id: "market-research", p_ops: [{ op: "insert_block",
  block: { id: randomUUID(), type: "file", fileId: attachedId, html: "Smoke attachment", indent: 0 } }] });
if (attach.status !== 200) throw new Error(`Attach failed: ${JSON.stringify(attach)}`);
const readAttached = (token) => raw("GET", `/storage/v1/object/files/${attachedPath}`, token);
check("a linked chat can read its granted attachment", (await readAttached(control.token)).status === 200);

const memberPassword = `Member-${randomUUID()}`, memberEmail = `member-${randomUUID()}@test.invalid`;
const memberUser = await raw("POST", "/auth/v1/admin/users", service, { email: memberEmail, password: memberPassword, email_confirm: true }, service);
if (memberUser.status !== 200) throw new Error(`Create member failed: ${JSON.stringify(memberUser)}`);
const membership = await person.from("workspace_members").insert({ workspace_id: agent.workspace_id, user_id: memberUser.json.id, role: "editor" });
if (membership.error) throw membership.error;
const member = createClient(base, anon, { auth: { persistSession: false, autoRefreshToken: false } });
const memberSession = await member.auth.signInWithPassword({ email: memberEmail, password: memberPassword });
if (memberSession.error) throw memberSession.error;
const sponsored = await person.functions.invoke("agent-admin", { body: { action: "create_agent", workspace_id: agent.workspace_id,
  name: "Former member smoke", kind: "mcp_client", sponsor_user_id: memberUser.json.id } });
if (sponsored.error) throw sponsored.error;
const grant = await rpc(owner, "grant_agent_page", { p_agent_id: sponsored.data.agent_id, p_page_id: "market-research", p_scopes: ["read", "write"] });
if (grant.status !== 200) throw new Error(`Grant failed: ${JSON.stringify(grant)}`);
const former = await connect("Member before removal", sponsored.data.agent_id, undefined, undefined, member);
check("the current member chat can read its granted attachment", (await readAttached(former.token)).status === 200);
const watchers = await Promise.all([["control", control.token], ["disconnected", linked.token], ["former-member", former.token],
  ...(second ? [["hidden-client", second]] : [])].map(([label, token]) => watch(token, label)));
try {
  for (const watcher of watchers) check(`Realtime ${watcher.label} subscription established`, watcher.status === "SUBSCRIBED", watcher.status);
  await wait(3000);
  const before = `before-revoke-${randomUUID()}`;
  const initialWrite = await rpc(control.token, "append_page_blocks", { p_page_id: "market-research", p_blocks: [{ type: "paragraph", spans: [before] }] });
  check("the linked control writes before revocation", initialWrite.status === 200);
  await wait(2000);
  for (const watcher of watchers.filter((w) => w.label !== "hidden-client")) {
    check(`Realtime ${watcher.label} receives content before revocation`, watcher.events.some((e) => JSON.stringify(e.new).includes(before)));
  }
  await disconnectApp(person, linked.clientId, true, agent.id);
  const removed = await person.from("workspace_members").delete().eq("workspace_id", agent.workspace_id).eq("user_id", memberUser.json.id);
  if (removed.error) throw removed.error;
  check("a disconnected chat is refused at once", (await rpc(linked.token, "session_identity")).status === 401);
  check("a former member is refused by the Data API", (await rpc(former.token, "session_identity")).status === 401);
  check("Storage remains confined after Disconnect", (await raw("GET", `/storage/v1/object/files/${file}`, linked.token)).status >= 400);
  for (const [label, token] of [["disconnected", linked.token], ["former-member", former.token], ...(second ? [["hidden-client", second]] : [])]) {
    check(`${label} cannot read the previously granted attachment`, (await readAttached(token)).status >= 400);
    const attempt = await raw("PUT", "/auth/v1/user", token, { password: changedPassword });
    check(`${label} cannot change credentials after revocation`, attempt.status >= 400, { status: attempt.status });
    const email = `agent+${label === "former-member" ? sponsored.data.agent_id : agent.id}@agents.invalid`;
    check(`${label} cannot open a direct session after revocation`, (await raw("POST", "/auth/v1/token?grant_type=password", anon, { email, password: changedPassword })).status >= 400);
  }
  const after = `after-revoke-${randomUUID()}`;
  for (const watcher of watchers) watcher.events.length = 0;
  const write = await rpc(control.token, "append_page_blocks", { p_page_id: "market-research", p_blocks: [{ type: "paragraph", spans: [after] }] });
  check("the other linked client can still write", write.status === 200);
  await wait(3000);
  for (const watcher of watchers) {
    check(`Realtime ${watcher.label} ${watcher.label === "control" ? "still receives" : "receives no"} content after revocation`,
      watcher.label === "control" ? watcher.events.some((e) => JSON.stringify(e.new).includes(after)) : watcher.events.length === 0, { events: watcher.events.length });
  }
  check("the control attachment remains accessible", (await readAttached(control.token)).status === 200);
} finally { await Promise.all(watchers.map((watcher) => watcher.close())); }
const humanChange = await member.auth.updateUser({ password: changedPassword });
check("a person can still change their own password", !humanChange.error);
check("the person can log in with that new password", (await raw("POST", "/auth/v1/token?grant_type=password", anon, { email: memberEmail, password: changedPassword })).status === 200);
const revoked = await person.functions.invoke("agent-admin", { body: { action: "revoke_agent", agent_id: sponsored.data.agent_id } });
check("credential freezing preserves revoke_agent bans", !revoked.error && revoked.data?.login_blocked === true);
check("the person's own session is untouched", (await rpc(owner, "session_identity")).status === 200);
const stillHuman = await raw("POST", "/auth/v1/token?grant_type=password", anon, { email: "owner@demo.local", password });
check("the person's original password still works", stillHuman.status === 200);
console.log(failed ? `${failed} failed` : "all ok");
process.exit(failed ? 1 : 0);
