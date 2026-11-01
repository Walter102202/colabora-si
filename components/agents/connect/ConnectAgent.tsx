import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { mcpUrls, useAgentsStore, type AgentRole } from "@/lib/agentsStore";
import { workspaceMcpUrl } from "@/lib/agentSnippets";
import { createAgentConnectCatalog, setupMessage } from "@/lib/agentConnectCatalog";
import { connectStep, loadConnectAttempt, loadConnections, pickConnection, saveConnectAttempt, setConnectSkipped, type ConnectAttempt, type ConnectionRow } from "@/lib/agentConnect";
import { connectUrl, HOME_URL } from "@/lib/routes";
import { ConnectChooser } from "./ConnectChooser";
import { ConnectSetup } from "./ConnectSetup";
import { ConnectOwnAgent } from "./ConnectOwnAgent";
import { ConnectDone, FIRST_CONNECT_TASK } from "./ConnectDone";
import { ConnectStatus } from "./ConnectStatus";

export function ConnectAgent() {
  const { agent } = useParams(), navigate = useNavigate(), client = getSupabase();
  const workspaceId = useStore((state) => state.syncWorkspaceId), userId = useAuthStore((state) => state.user?.id);
  const [attempt, setAttempt] = useState<ConnectAttempt | null>(loadConnectAttempt), [connection, setConnection] = useState<ConnectionRow | null>(null);
  const [copiedAgent, setCopiedAgent] = useState<string | null>(null), [failedAgent, setFailedAgent] = useState<string | null>(null);
  const [ownName, setOwnName] = useState(""), [ownRole, setOwnRole] = useState<AgentRole>("worker");
  const [token, setToken] = useState<string | null>(null), [tokenVisible, setTokenVisible] = useState(true), [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null), [copiedFirst, setCopiedFirst] = useState(false), [now, setNow] = useState(Date.now);
  const creatingRef = useRef(false), createdId = useRef<string | null>(null);
  const [progress, setProgress] = useState(() => ({ step: "waiting", at: attempt?.startedAt ?? now }));
  const activeAttempt = attempt?.agent === agent ? attempt : null;
  const step = connectStep(activeAttempt ? { copied: true } : null, activeAttempt ? connection : null);
  const refresh = useCallback(async () => {
    if (!client || !workspaceId || !userId || !activeAttempt) return;
    const rows = await loadConnections(client, workspaceId);
    return pickConnection(rows, activeAttempt);
  }, [client, workspaceId, userId, activeAttempt]);
  useEffect(() => {
    if (!activeAttempt || !userId || !workspaceId || step === "connected") return;
    let cancelled = false, pending = false;
    const check = async () => {
      if (document.visibilityState !== "visible" || pending) return;
      pending = true;
      try {
        const row = await refresh();
        if (cancelled) return;
        const next = connectStep({ copied: true }, row ?? null);
        const checkedAt = Date.now();
        setProgress((previous) => previous.step === next ? previous : { step: next, at: checkedAt });
        setConnection(row ?? null); setError(null); setNow(Date.now());
      } catch { if (!cancelled) setError("We couldn’t check this connection. Try again."); }
      finally { pending = false; }
    };
    void check(); const interval = setInterval(() => { setNow(Date.now()); void check(); }, 3000);
    const visible = () => { void check(); }; document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [activeAttempt, userId, workspaceId, step, refresh]);
  if (!isSupabaseConfigured()) return <p className="p-6 text-sm text-text-secondary">Agents need the cloud. Configure a backend to register them.</p>;
  const urls = mcpUrls(), catalog = createAgentConnectCatalog(urls.mcpUrl), entry = catalog.find((item) => item.id === agent);
  const name = entry?.route === "own" ? ownName.trim() || entry.name : entry?.name ?? "your agent";
  const settings = token ? `WORKSPACE_MCP_URL=${urls.mcpUrl}\nWORKSPACE_AGENT_TOKEN_URL=${urls.tokenUrl}\nWORKSPACE_AGENT_PAT=${token}` : "";
  const begin = (startedAt: number, agentId?: string) => {
    if (!entry) return;
    const next = { agent: entry.id, startedAt, ...(agentId ? { agentId } : {}) };
    saveConnectAttempt(next); setAttempt(next); setConnection(null); setProgress({ step: "waiting", at: next.startedAt }); setNow(next.startedAt);
  };
  const copy = async (startedAt: number) => {
    if (!entry) return;
    try { await navigator.clipboard.writeText(setupMessage(entry)); setCopiedAgent(entry.id); setFailedAgent(null); if (!activeAttempt) begin(startedAt); }
    catch { setFailedAgent(entry.id); setCopiedAgent(null); }
  };
  const copyFirst = async () => {
    try { await navigator.clipboard.writeText(FIRST_CONNECT_TASK); setCopiedFirst(true); setError(null); }
    catch { setError("We couldn’t copy the first task. Select it and copy it yourself."); }
  };
  const copySettings = async () => {
    if (!settings) { setError("This token is no longer shown. You can issue another in Settings → Agents."); return; }
    try { await navigator.clipboard.writeText(settings); setTokenVisible(false); setError(null); }
    catch { setError("We couldn’t copy the settings. Select them and copy them yourself."); }
  };
  const createOwn = async (startedAt: number) => {
    if (!client || !workspaceId || !userId || creatingRef.current) return;
    creatingRef.current = true; setCreating(true); setError(null);
    try {
      if (!createdId.current) {
        const { data, error: failure } = await client.functions.invoke("agent-admin", { body: { action: "connect_own_agent", workspace_id: workspaceId, name: ownName.trim(), role: ownRole } });
        if (failure) throw failure;
        if (typeof data?.agent_id !== "string") throw new Error("No agent was created");
        createdId.current = data.agent_id;
      }
      const id = createdId.current!;
      const issued = await useAgentsStore.getState().issueToken(id, "default");
      setToken(issued); setTokenVisible(true); begin(startedAt, id);
    } catch { setError("We couldn’t finish saving this connection. Try again."); }
    finally { creatingRef.current = false; setCreating(false); }
  };
  const check = async () => { try { const row = await refresh(); setConnection(row ?? null); setError(null); } catch { setError("We couldn’t check this connection. Try again."); } };
  const content = entry && activeAttempt ? step === "connected" && connection ? <ConnectDone name={name} pageId={connection.page_id} copied={copiedFirst} onCopy={() => void copyFirst()} /> : <>
    {token && tokenVisible ? <section className="mt-7 rounded-xl border border-border bg-bg-secondary p-5 text-sm"><p className="font-semibold">This token appears only once.</p><p className="text-text-secondary">Keep it in your agent’s settings, not in a chat.</p><pre className="my-4 whitespace-pre-wrap break-all text-xs">{settings}</pre><button type="button" className="min-h-11 rounded bg-accent px-4 text-white" onClick={() => void copySettings()}>Copy settings</button></section>
      : <ConnectStatus entry={entry} name={name} approved={step === "approved"} elapsed={now - progress.at} onCheck={() => void check()} onAgain={() => { void (entry.route === "own" ? copySettings() : copy(activeAttempt.startedAt)); }} onFirstTask={() => void copyFirst()} copiedFirst={copiedFirst} />}
  </> : undefined;
  return <div className="w-full">
    <div className="flex justify-end px-4 pt-2"><button type="button" className="min-h-11 rounded-md px-3 text-sm text-text-secondary hover:bg-bg-secondary" onClick={() => { if (workspaceId) setConnectSkipped(workspaceId); void navigate(HOME_URL); }}>Skip for now</button></div>
    <div className="mx-auto w-full max-w-[680px] px-6 pb-24 pt-8">
      {entry ? <ConnectSetup entry={entry} serverUrl={workspaceMcpUrl(urls.mcpUrl)} copied={copiedAgent === entry.id} copyError={failedAgent === entry.id} onCopy={() => { void copy(Date.now()); }} onOpen={() => begin(Date.now())} content={content} onChange={() => { saveConnectAttempt(null); setAttempt(null); setConnection(null); setToken(null); createdId.current = null; setCopiedAgent(null); setFailedAgent(null); setCopiedFirst(false); setError(null); void navigate(connectUrl()); }}>
        <ConnectOwnAgent name={ownName} role={ownRole} onName={setOwnName} onRole={setOwnRole} busy={creating} error={error} onCreate={userId && workspaceId ? () => void createOwn(Date.now()) : undefined} />
        {!userId ? <p className="p-4 text-sm text-text-secondary">Sign in to create an agent token.</p> : null}
      </ConnectSetup> : <ConnectChooser catalog={catalog} onChoose={(id) => { void navigate(connectUrl(id)); }} />}
      {error && (entry?.route !== "own" || activeAttempt) ? <p role="alert" className="mt-3 text-sm">{error}</p> : null}
    </div>
  </div>;
}
