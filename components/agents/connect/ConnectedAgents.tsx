import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { useAgentsStore } from "@/lib/agentsStore";
import { connectedRows, loadConnections, type ConnectedRow } from "@/lib/agentConnect";
import { connectWorkspaces } from "@/lib/agentConsent";
import { ConnectedAgentsList } from "./ConnectedAgentsList";

export function ConnectedAgents() {
  const client = getSupabase(), workspaceId = useStore((state) => state.syncWorkspaceId);
  const pages = useStore((state) => state.pages), userId = useAuthStore((state) => state.user?.id);
  const key = `${userId ?? ""}:${workspaceId ?? ""}`;
  const [snapshot, setSnapshot] = useState<{ key: string; rows: ConnectedRow[]; canConnect: boolean; error: boolean; loaded: boolean }>({ key: "", rows: [], canConnect: false, error: false, loaded: false });
  useEffect(() => {
    if (!client || !workspaceId || !userId) return;
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || pending) return;
      pending = true;
      try {
        const [, connections, spaces] = await Promise.all([
          useAgentsStore.getState().load(workspaceId), loadConnections(client, workspaceId), connectWorkspaces(client),
        ]);
        const state = useAgentsStore.getState();
        if (state.status !== "ready" || state.workspaceId !== workspaceId || state.userId !== userId) throw new Error("Agents unavailable");
        if (!cancelled) setSnapshot({ key, rows: connectedRows(state.agents, connections), canConnect: spaces.some((space) => space.id === workspaceId), error: false, loaded: true });
      } catch {
        if (!cancelled) setSnapshot((previous) => previous.key === key ? { ...previous, error: true } : { key, rows: [], canConnect: false, error: true, loaded: false });
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const visible = () => { void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [client, workspaceId, userId, key]);
  if (!client) return <p className="p-6 text-sm text-text-secondary">Agents need the cloud. Configure a backend to register them.</p>;
  if (!userId || !workspaceId) return <p className="p-6 text-sm text-text-secondary">Sign in to manage agents.</p>;
  const current = snapshot.key === key ? snapshot : null;
  return <ConnectedAgentsList rows={current?.rows ?? []} pages={pages} canConnect={current?.canConnect ?? false} error={current?.error ?? false} loading={!current?.loaded && !current?.error} />;
}
