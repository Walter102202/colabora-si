"use client";

import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";
import { activeRunFor, subtaskWorkers, taskForPage, useAgentTasks } from "@/lib/agentTasks";
import { taskSubtitle } from "@/lib/agentTaskText";
import { StatusBadge } from "@/components/agents/panel/StatusBadge";

export { StatusBadge };

// Agent layer plug. Mounted by the database views as the cell of the
// `agentStatus` and `agentDelegate` property types. Read-only: the row panel
// is where the person acts.
export interface AgentPropertyCellProps {
  pageId: string;
  propertyId: string;
  kind: "agentStatus" | "agentDelegate";
}

export function AgentPropertyCell({ pageId, kind }: AgentPropertyCellProps) {
  const workspaceId = useStore((s) => s.syncWorkspaceId);
  const subscribe = useAgentTasks((s) => s.subscribe);
  const loadAgents = useAgentsStore((s) => s.load);
  useEffect(() => {
    if (!workspaceId) return;
    void loadAgents(workspaceId);
    return subscribe(workspaceId);
  }, [workspaceId, subscribe, loadAgents]);
  const task = useAgentTasks((s) => taskForPage(s, pageId));
  const run = useAgentTasks((s) => (task ? activeRunFor(s, task) : null));
  const agents = useAgentsStore((s) => s.agents);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "Agent";
  const agentName = task?.delegate_agent_id ? nameOf(task.delegate_agent_id) : null;
  // A task with subtasks shows who does them; the agent it is assigned to already appears as its Lead.
  const workers = useAgentTasks((s) => (task && kind === "agentDelegate" ? subtaskWorkers(s.tasks, task.id).join(",") : ""));
  const workerIds = workers ? workers.split(",") : [];
  const workerName = workerIds.length > 1 ? `${workerIds.length} workers` : workerIds.length === 1 ? nameOf(workerIds[0]) : agentName;

  if (kind === "agentDelegate") {
    return <span className={"cell-readonly " + (workerName ? "" : "text-text-tertiary")} title={workerName ? "Assigned agent" : "Open the row to assign an agent"}>{workerName ?? "Unassigned"}</span>;
  }
  if (!task) return <span className="cell-readonly text-text-tertiary" title="Open the row to hand it to an agent">No task</span>;
  return (
    <span className="cell-readonly" title={taskSubtitle(task, run, agentName)}>
      <StatusBadge task={task} run={run} agentName={agentName} />
    </span>
  );
}
