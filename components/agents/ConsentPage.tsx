import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import AuthModal from "@/components/AuthModal";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { approveConsent, denyConsent, linkableAgents, loadConsent, safeRedirect, type ConsentState, type LinkableAgent } from "@/lib/agentConsent";

const EXPIRED = "This request expired. Go back to the app and connect again.";
function navigate(url: string) {
  const safe = safeRedirect(url);
  if (!safe) throw new Error("The app returned an unsafe address. Go back and connect again.");
  window.location.assign(safe);
}

export function ConsentPage() {
  const [params] = useSearchParams();
  const authorizationId = params.get("authorization_id");
  const client = getSupabase();
  const { user, loading } = useAuth();
  const framed = window.top !== window.self;
  const [detail, setDetail] = useState<Extract<ConsentState, { kind: "ask" }> | null>(null);
  const [agents, setAgents] = useState<LinkableAgent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [mode, setMode] = useState("human");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authorizationId || !client || !user || framed) return;
    let cancelled = false;
    void (async () => {
      try {
        const state = await loadConsent(client, authorizationId);
        if (cancelled) return;
        if (state.kind === "redirect") { navigate(state.url); return; }
        const available = await linkableAgents(client);
        if (cancelled) return;
        setAgents(available); setAgentId(available[0]?.id ?? "");
        setMode(available.length ? "agent" : "human"); setDetail(state);
      } catch { if (!cancelled) setError(EXPIRED); }
    })();
    return () => { cancelled = true; };
  }, [authorizationId, client, user, framed]);

  if (framed) return <main className="empty-state">Open this connection in its own browser tab.</main>;
  if (!authorizationId) return <main className="empty-state">This link is incomplete. Go back to the app and connect again.</main>;
  if (!client) return <main className="empty-state">Sign-in is not available here.</main>;
  if (loading) return <main className="empty-state" aria-busy="true">Loading…</main>;
  if (!user) return <AuthModal onClose={() => {}} redirectTo={window.location.href} />;
  if (!detail) return <main className="empty-state">{error ? <p role="alert">{error}</p> : <p aria-busy="true">Loading…</p>}</main>;

  const decide = async (approve: boolean) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      navigate(approve
        ? await approveConsent(client, detail.authorizationId, detail.clientId, mode === "agent" ? agentId : null)
        : await denyConsent(client, detail.authorizationId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not finish this connection. Try again.");
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto max-w-lg space-y-6 px-6 py-16" aria-labelledby="consent-title">
      <header className="space-y-3">
        <h1 id="consent-title" className="text-2xl font-semibold">{detail.clientName} wants to connect to colabora.si</h1>
        <p>After you approve, you return to <strong className="break-all">{detail.redirectHost}</strong>.</p>
        <p className="rounded border border-border bg-bg-secondary p-3 text-sm">The app wrote this name itself. Check the address above before you approve.</p>
      </header>
      <fieldset className="space-y-4" disabled={busy}>
        <legend className="mb-3 font-medium">Connect this app</legend>
        {agents.length > 0 && <div className="space-y-2">
          <label className="flex items-center gap-2"><input type="radio" name="principal" value="agent" checked={mode === "agent"} onChange={() => setMode("agent")} />As an agent</label>
          <label className="block text-sm">Agent
            <select className="ml-2 rounded border border-border bg-bg px-2 py-1" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={mode !== "agent"}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <p className="text-sm text-text-secondary">It reaches only the pages that agent can. Its work is signed by the agent, via chat.</p>
        </div>}
        <div className="space-y-2">
          <label className="flex items-center gap-2"><input type="radio" name="principal" value="human" checked={mode === "human"} onChange={() => setMode("human")} />As you</label>
          <p className="text-sm text-text-secondary">It can read and change everything you can.</p>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      <div className="flex gap-3">
        <button type="button" className="rounded bg-accent px-4 py-2 text-white disabled:opacity-50" disabled={busy} onClick={() => void decide(true)}>Approve</button>
        <button type="button" className="rounded border border-border px-4 py-2 disabled:opacity-50" disabled={busy} onClick={() => void decide(false)}>Deny</button>
      </div>
      <p className="text-sm text-text-secondary">Signed in as {detail.email}</p>
    </main>
  );
}
