import { useEffect, useMemo, useState } from "react";
import { DiscrepanciesHome } from "@/components/agents/DiscrepanciesHome";
import { LessonsHome } from "@/components/agents/LessonsHome";
import { DecisionsHomeView } from "@/components/agents/panel/DecisionsHomeView";
import { getAgentClient } from "@/lib/agentClient";
import { buildDecisionsHome } from "@/lib/agentHome";
import { useAgentTasks } from "@/lib/agentTasks";
import { useAgentsStore } from "@/lib/agentsStore";
import { useAuthStore } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { decideApproval } from "@/lib/agentActions";

// Agent layer plug for the Home: what waits on the signed-in person and what agents are doing for them.
// Hidden without a backend or a session. Track B mounts it in app/(workspace)/page.tsx.
export function DecisionsHome() {
  const workspaceId = useStore((s) => s.syncWorkspaceId);
  const syncUserId = useStore((s) => s.syncUserId);
  const sessionUserId = useAuthStore((s) => s.user?.id ?? null);
  // The persisted sync ids outlive a sign-out: they count only while they are the signed-in person's.
  const userId = syncUserId && syncUserId === sessionUserId ? syncUserId : null;
  const active = !!getAgentClient() && !!workspaceId && !!userId;
  const tasks = useAgentTasks((s) => s.tasks);
  const approvals = useAgentTasks((s) => s.approvals);
  const runs = useAgentTasks((s) => s.runs);
  const status = useAgentTasks((s) => s.status);
  const error = useAgentTasks((s) => s.error);
  const subscribe = useAgentTasks((s) => s.subscribe);
  const load = useAgentTasks((s) => s.load);
  const agents = useAgentsStore((s) => s.agents);
  const loadAgents = useAgentsStore((s) => s.load);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !workspaceId) return;
    void loadAgents(workspaceId);
    return subscribe(workspaceId);
  }, [active, workspaceId, subscribe, loadAgents]);
  // A later subscriber shares the channel without loading again, so a failed load is retried here.
  useEffect(() => {
    if (!active || !workspaceId || status !== "error") return;
    const retry = () => void load(workspaceId);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [active, workspaceId, status, load]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const home = useMemo(() => buildDecisionsHome({
    tasks: Object.values(tasks), approvals: Object.values(approvals), runs, agents, userId, now,
  }), [tasks, approvals, runs, agents, userId, now]);

  if (!active || !workspaceId) return null;
  return (
    <>
      <LessonsHome workspaceId={workspaceId} />
      <DiscrepanciesHome workspaceId={workspaceId} />
      <DecisionsHomeView
        home={home}
        approvals={Object.values(approvals)}
        onDecide={(id, decision, response) => decideApproval(id, decision, response).then(() => undefined)}
        loading={(status === "idle" || status === "loading") && Object.keys(tasks).length === 0}
        error={status === "error" ? error ?? "Unknown error" : null}
        onRetry={() => void load(workspaceId)}
      />
    </>
  );
}
