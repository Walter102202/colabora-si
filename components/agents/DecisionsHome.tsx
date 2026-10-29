import { useEffect, useMemo, useState } from "react";
import { DecisionsHomeView } from "@/components/agents/panel/DecisionsHomeView";
import { buildDecisionsHome } from "@/lib/agentHome";
import { useAgentTasks } from "@/lib/agentTasks";
import { useAgentsStore } from "@/lib/agentsStore";
import { useStore } from "@/lib/store";

// Agent layer plug for the Home: what waits on the signed-in person and what agents are doing for them.
// Hidden without a session. Track B mounts it in app/(workspace)/page.tsx.
export function DecisionsHome() {
  const workspaceId = useStore((s) => s.syncWorkspaceId);
  const userId = useStore((s) => s.syncUserId);
  const tasks = useAgentTasks((s) => s.tasks);
  const approvals = useAgentTasks((s) => s.approvals);
  const runs = useAgentTasks((s) => s.runs);
  const status = useAgentTasks((s) => s.status);
  const subscribe = useAgentTasks((s) => s.subscribe);
  const agents = useAgentsStore((s) => s.agents);
  const loadAgents = useAgentsStore((s) => s.load);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!workspaceId) return;
    void loadAgents(workspaceId);
    return subscribe(workspaceId);
  }, [workspaceId, subscribe, loadAgents]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const home = useMemo(() => buildDecisionsHome({
    tasks: Object.values(tasks), approvals: Object.values(approvals), runs, agents, userId, now,
  }), [tasks, approvals, runs, agents, userId, now]);

  if (!workspaceId || !userId) return null;
  return <DecisionsHomeView home={home} loading={(status === "idle" || status === "loading") && Object.keys(tasks).length === 0} />;
}
