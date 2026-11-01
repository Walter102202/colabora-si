import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import AuthModal from "@/components/AuthModal";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { HOME_URL } from "@/lib/routes";
import { approveConsent, cancelConsent, connectAgent, connectWorkspaces, consentContext, denyConsent, linkableAgents, loadConsent, safeRedirect, trustedHumanRedirect,
  type ConsentContext, type ConsentState, type ConnectWorkspace, type LinkableAgent } from "@/lib/agentConsent";

const EXPIRED = "This approval link has expired. Start a new connection from your agent.";
function navigate(url: string) {
  const safe = safeRedirect(url);
  if (!safe) throw new Error("The app returned an unsafe address.");
  window.location.assign(safe);
}
export function ConsentPage() {
  const [params] = useSearchParams(), auth = useAuth();
  const authorizationId = params.get("authorization_id");
  return <ConsentFlow key={`${authorizationId}:${auth.user?.id ?? ""}`} authorizationId={authorizationId} auth={auth} />;
}
function ConsentFlow({ authorizationId, auth }: { authorizationId: string | null; auth: ReturnType<typeof useAuth> }) {
  const client = getSupabase(), { user, loading } = auth, userId = user?.id, framed = window.top !== window.self;
  const [context, setContext] = useState<ConsentContext | null>(null);
  const [detail, setDetail] = useState<Extract<ConsentState, { kind: "ask" }> | null>(null);
  const [agents, setAgents] = useState<LinkableAgent[]>([]), [workspaces, setWorkspaces] = useState<ConnectWorkspace[]>([]);
  const [agentId, setAgentId] = useState(""), [workspaceId, setWorkspaceId] = useState(""), [name, setName] = useState("");
  const [mode, setMode] = useState<"new" | "agent" | "human">("new"), [role, setRole] = useState<"worker" | "lead">("worker");
  const [error, setError] = useState<string | null>(null), [blocked, setBlocked] = useState(false), [busy, setBusy] = useState(false);
  const alive = useRef(true), inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!authorizationId || !client || !userId || framed) return;
    let cancelled = false;
    void Promise.all([consentContext(client, authorizationId), connectWorkspaces(client), linkableAgents(client)]).then(([ctx, spaces, available]) => {
      if (cancelled) return;
      const matched = available.find((agent) => agent.name.toLowerCase() === ctx.clientName.toLowerCase() && spaces.some((space) => space.id === agent.workspace_id));
      setContext(ctx); setWorkspaces(spaces); setAgents(available); setName(ctx.clientName);
      setWorkspaceId(matched?.workspace_id ?? spaces[0]?.id ?? ""); setAgentId(matched?.id ?? ""); setMode(matched ? "agent" : "new");
    }).catch(() => { if (!cancelled) { setError(EXPIRED); setBlocked(true); } });
    return () => { cancelled = true; };
  }, [authorizationId, client, userId, framed]);
  if (framed) return <main className="empty-state">Open this connection in its own browser tab.</main>;
  if (!authorizationId) return <main className="empty-state">This link is incomplete. Go back to the app and connect again.</main>;
  if (!client) return <main className="empty-state">Sign-in is not available here.</main>;
  if (loading) return <main className="empty-state" aria-busy="true">Loading…</main>;
  if (!user) return <AuthModal onClose={() => {}} redirectTo={window.location.href} />;
  const trusted = context ? trustedHumanRedirect(context.redirectUri) : false;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const available = agents.filter((agent) => agent.workspace_id === workspaceId);
  const selected = available.find((agent) => agent.id === agentId);
  const displayName = mode === "agent" ? selected?.name ?? context?.clientName : name.trim();
  const run = async (action: "connect" | "cancel" | "human" | "approve" | "deny") => {
    if (inFlight.current || blocked || !context) return;
    if (action === "connect" && mode === "new" && (name.trim().length < 1 || name.trim().length > 80)) {
      setError("Enter an agent name from 1 to 80 characters."); return;
    }
    inFlight.current = true; setBusy(true); setError(null);
    try {
      if (action === "human") {
        const result = await loadConsent(client, authorizationId, null);
        if (!alive.current) return;
        if (result.kind === "redirect") navigate(result.url); else setDetail(result);
      } else {
        const url = action === "cancel" ? await cancelConsent(client, authorizationId, context.clientId)
          : action === "approve" && detail ? await approveConsent(client, authorizationId, detail.clientId, null, detail)
            : action === "deny" ? await denyConsent(client, authorizationId, null)
              : await connectAgent(client, { authorizationId, workspaceId, ...(mode === "agent" ? { agentId } : { name: name.trim(), role }) });
        if (alive.current) navigate(url);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error && /expired|not_found/i.test(e.message) ? EXPIRED : "We couldn’t finish saving this connection.");
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  if (context && !workspaces.length && !trusted) return <main className="empty-state"><p>You don’t have a workspace you can connect here.</p><Link to={HOME_URL}>Go to Home</Link></main>;
  const destination = context ? new URL(context.redirectUri) : null;
  const loopback = destination && ["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname);
  return <main className="mx-auto max-w-lg space-y-6 px-6 py-12" aria-labelledby="consent-title">
    <header><h1 id="consent-title" className="text-2xl font-semibold">{context ? `Connect ${context.clientName}` : "Approve connection"}</h1>{workspace && mode !== "human" ? <p className="mt-1 text-text-secondary">to {workspace.name}</p> : null}</header>
    {!context && !blocked ? <p aria-busy="true">Loading…</p> : null}
    {context && !blocked ? <>
      {trusted && !detail ? <fieldset disabled={busy} className="flex gap-5"><legend className="mb-2 text-sm">Connect this app</legend>
        <label><input type="radio" name="principal" value="agent" checked={mode !== "human"} onChange={() => setMode(selected ? "agent" : "new")} /> As an agent</label>
        <label><input type="radio" name="principal" value="human" checked={mode === "human"} onChange={() => setMode("human")} /> As you</label>
      </fieldset> : null}
      {mode !== "human" ? <fieldset disabled={busy} className="space-y-4">
        <legend className="sr-only">Agent connection</legend>
        {workspaces.length > 1 ? <label className="block">Workspace<select className="mt-1 min-h-11 w-full rounded border border-border bg-bg px-3" value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setAgentId(""); setMode("new"); }}>{workspaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label> : null}
        {available.length ? <label className="block">Agent<select className="mt-1 min-h-11 w-full rounded border border-border bg-bg px-3" value={mode === "agent" ? agentId : "new"} onChange={(event) => { setAgentId(event.target.value === "new" ? "" : event.target.value); setMode(event.target.value === "new" ? "new" : "agent"); }}><option value="new">Create a new agent</option>{available.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label> : null}
        {mode === "new" ? <>
          <label className="block">Agent name<input className="mt-1 min-h-11 w-full rounded border border-border bg-bg px-3" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></label>
          <label className="block">Role<select className="mt-1 min-h-11 w-full rounded border border-border bg-bg px-3" value={role} onChange={(event) => setRole(event.target.value as "worker" | "lead")}><option value="worker">Worker</option><option value="lead">Lead</option></select></label>
          <p className="text-sm text-text-secondary">{role === "worker" ? "Works on the tasks it is given." : "Creates tasks, delegates them to other agents and reviews their work."}</p>
        </> : null}
        <section className="space-y-2 rounded-lg border border-border bg-bg-secondary p-4"><h2 className="text-sm text-text-secondary">Page access</h2><p className="font-medium">Getting started</p><p className="text-sm">{mode === "new" ? "We’ll create this shared page for you and your agent." : "Adds Getting started to what this agent can already reach."}</p>
          <p>{displayName} will be able to:</p><ul className="list-disc space-y-1 pl-5 text-sm"><li>Read, edit, and archive this page and its subpages.</li><li>Create and move pages within this area.</li></ul>
          {mode === "new" ? <p className="text-sm">Your other pages and account settings stay outside this connection.</p> : null}
        </section>
        <p className="text-sm text-text-secondary">Your agent provider receives the content the agent reads. Disconnecting stops future access.</p>
      </fieldset> : <p className="text-sm">It can read and change everything you can, including your account. Only trusted chat hosts can use this option.</p>}
      <dl className="space-y-4 text-sm"><div><dt className="font-medium">Requesting app</dt><dd>{context.clientName}</dd><dd className="text-text-secondary">This name was supplied by the app.</dd></div>
        <div><dt className="font-medium">Return address</dt><dd className="break-all">{context.redirectUri}</dd><dd className="mt-1 text-text-secondary">{loopback ? "This returns to an app on this computer." : context.redirectIsApp ? `After approval, this opens ${destination?.protocol.replace(":", "")} on your device.` : `After approval, you’ll return to ${destination?.origin}.`}</dd></div>
      </dl>
      {busy ? <p role="status" className="text-sm">{mode === "new" ? "Creating your agent and saving page access." : "Saving this connection."}</p> : null}
      <div className="flex gap-3"><button type="button" className="min-h-11 rounded bg-accent px-4 text-white disabled:opacity-50" disabled={busy || (mode !== "human" && (!workspaceId || (mode === "agent" && !selected)))} onClick={() => void run(mode === "human" ? detail ? "approve" : "human" : "connect")}>{busy ? "Connecting…" : error ? "Try again" : mode === "human" ? detail ? "Approve" : "Continue" : `Connect ${displayName}`}</button>
        <button type="button" className="min-h-11 rounded border border-border px-4 disabled:opacity-50" disabled={busy} onClick={() => void run(mode === "human" && detail ? "deny" : "cancel")}>Cancel</button></div>
    </> : null}
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    <footer className="text-sm text-text-secondary"><p>Signed in as {user.email ?? detail?.email}</p><p>You can disconnect this app in Settings → Agents.</p></footer>
  </main>;
}
