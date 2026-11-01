import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { useAgentsStore, type AgentRole } from "@/lib/agentsStore";
import { connectedRows, loadConnections, type ConnectedRow } from "@/lib/agentConnect";
import { connectWorkspaces } from "@/lib/agentConsent";
import { getAutonomyPolicy, setWorkspaceAutonomy } from "@/lib/agentActions";
import type { AutonomyLevel, AutonomyPolicy } from "@/lib/agentAutonomy";
import { ConnectedAgentsList } from "./ConnectedAgentsList";

export function ConnectedAgents() {
  const client = getSupabase(), workspaceId = useStore((state) => state.syncWorkspaceId);
  const userId = useAuthStore((state) => state.user?.id);
  if (!client) return <p className="p-6 text-sm text-text-secondary">Agents need the cloud. Configure a backend to register them.</p>;
  if (!userId || !workspaceId) return <p className="p-6 text-sm text-text-secondary">Sign in to manage agents.</p>;
  return <ConnectedAgentsSession key={`${userId}:${workspaceId}`} client={client} workspaceId={workspaceId} userId={userId} />;
}

function ConnectedAgentsSession({ client, workspaceId, userId }: {
  client: NonNullable<ReturnType<typeof getSupabase>>; workspaceId: string; userId: string;
}) {
  const pages = useStore((state) => state.pages);
  const [snapshot, setSnapshot] = useState<{ rows: ConnectedRow[]; policy: AutonomyPolicy | null; canConnect: boolean; error: boolean; loaded: boolean }>({ rows: [], policy: null, canConnect: false, error: false, loaded: false });
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const mutations = useRef(0), revision = useRef(0);
  useEffect(() => {
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || pending || mutations.current) return;
      pending = true;
      const started = revision.current;
      try {
        const [, connections, spaces, policy] = await Promise.all([
          useAgentsStore.getState().load(workspaceId), loadConnections(client, workspaceId), connectWorkspaces(client), getAutonomyPolicy(workspaceId),
        ]);
        const state = useAgentsStore.getState();
        if (state.status !== "ready" || state.workspaceId !== workspaceId || state.userId !== userId) throw new Error("Agents unavailable");
        if (!cancelled && started === revision.current) setSnapshot({ rows: connectedRows(state.agents, connections), policy, canConnect: spaces.some((space) => space.id === workspaceId), error: false, loaded: true });
      } catch {
        if (!cancelled && started === revision.current) setSnapshot((previous) => ({ ...previous, error: true }));
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const visible = () => { void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [client, workspaceId, userId]);

  const save = async (id: string, action: () => Promise<unknown>, rollback: () => void) => {
    mutations.current++; revision.current++;
    setSaving((previous) => ({ ...previous, [id]: true }));
    setErrors((previous) => ({ ...previous, [id]: null }));
    try { await action(); }
    catch (error) {
      rollback();
      setErrors((previous) => ({ ...previous, [id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      mutations.current--; revision.current++;
      setSaving((previous) => ({ ...previous, [id]: false }));
    }
  };
  const changeAgent = (row: ConnectedRow, patch: Partial<Pick<ConnectedRow, "role" | "autonomy">>, action: () => Promise<void>) => {
    if (!snapshot.policy?.can_edit || saving[row.agentId]) return;
    setSnapshot((previous) => ({ ...previous, rows: previous.rows.map((item) => item.agentId === row.agentId ? { ...item, ...patch } : item) }));
    void save(row.agentId, action, () => setSnapshot((previous) => ({ ...previous, rows: previous.rows.map((item) => item.agentId === row.agentId ? { ...item, role: row.role, autonomy: row.autonomy } : item) })));
  };
  const changeWorkspace = (level: AutonomyLevel) => {
    const policy = snapshot.policy;
    if (!policy?.can_edit || saving.workspace) return;
    setSnapshot((previous) => ({ ...previous, policy: { ...policy, level } }));
    void save("workspace", () => setWorkspaceAutonomy(workspaceId, level), () => setSnapshot((previous) => ({ ...previous, policy })));
  };
  return <ConnectedAgentsList rows={snapshot.rows} pages={pages} canConnect={snapshot.canConnect} error={snapshot.error} loading={!snapshot.loaded && !snapshot.error}
    policy={snapshot.policy} saving={saving} errors={errors} onWorkspaceChange={changeWorkspace}
    onRoleChange={(row: ConnectedRow, role: AgentRole) => changeAgent(row, { role }, () => useAgentsStore.getState().setAgentRole(row.agentId, role))}
    onAutonomyChange={(row: ConnectedRow, autonomy: AutonomyLevel | null) => changeAgent(row, { autonomy }, () => useAgentsStore.getState().setAgentAutonomy(row.agentId, autonomy))} />;
}
