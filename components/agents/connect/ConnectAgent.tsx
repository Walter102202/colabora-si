import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useStore } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/supabase";
import { mcpUrls, type AgentRole } from "@/lib/agentsStore";
import { workspaceMcpUrl } from "@/lib/agentSnippets";
import { createAgentConnectCatalog, setupMessage } from "@/lib/agentConnectCatalog";
import { setConnectSkipped } from "@/lib/agentConnect";
import { connectUrl, HOME_URL } from "@/lib/routes";
import { ConnectChooser } from "./ConnectChooser";
import { ConnectSetup } from "./ConnectSetup";
import { ConnectOwnAgent } from "./ConnectOwnAgent";

export function ConnectAgent() {
  const { agent } = useParams(), navigate = useNavigate();
  const workspaceId = useStore((state) => state.syncWorkspaceId);
  const [copiedAgent, setCopiedAgent] = useState<string | null>(null), [failedAgent, setFailedAgent] = useState<string | null>(null);
  const [ownName, setOwnName] = useState(""), [ownRole, setOwnRole] = useState<AgentRole>("worker");
  if (!isSupabaseConfigured()) return <p className="p-6 text-sm text-text-secondary">Agents need the cloud. Configure a backend to register them.</p>;
  const mcpUrl = mcpUrls().mcpUrl, catalog = createAgentConnectCatalog(mcpUrl), entry = catalog.find((item) => item.id === agent);
  const copy = async () => {
    if (!entry) return;
    try { await navigator.clipboard.writeText(setupMessage(entry)); setCopiedAgent(entry.id); setFailedAgent(null); }
    catch { setFailedAgent(entry.id); setCopiedAgent(null); }
  };
  return <div className="w-full">
    <div className="flex justify-end px-4 pt-2"><button type="button" className="min-h-11 rounded-md px-3 text-sm text-text-secondary hover:bg-bg-secondary" onClick={() => { if (workspaceId) setConnectSkipped(workspaceId); void navigate(HOME_URL); }}>Skip for now</button></div>
    <div className="mx-auto w-full max-w-[680px] px-6 pb-24 pt-8">
      {entry ? <ConnectSetup entry={entry} serverUrl={workspaceMcpUrl(mcpUrl)} copied={copiedAgent === entry.id} copyError={failedAgent === entry.id} onCopy={() => { void copy(); }} onChange={() => { setCopiedAgent(null); setFailedAgent(null); void navigate(connectUrl()); }}>
        <ConnectOwnAgent name={ownName} role={ownRole} onName={setOwnName} onRole={setOwnRole} />
      </ConnectSetup> : <ConnectChooser catalog={catalog} onChoose={(id) => { void navigate(connectUrl(id)); }} />}
    </div>
  </div>;
}
