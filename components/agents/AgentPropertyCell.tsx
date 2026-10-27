"use client";

import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";
import { activeRunFor, taskForPage, useAgentTasks, type RunRow, type TaskRow } from "@/lib/agentTasks";
import { TASK_STATE_LABEL, type TaskState } from "@/lib/agentState";
import { formatRelative } from "@/lib/utils";

// Agent layer plug. Mounted by the database views as the cell of the
// `agentStatus` and `agentDelegate` property types. Read-only: the row panel
// is where the person acts.
export interface AgentPropertyCellProps {
  pageId: string;
  propertyId: string;
  kind: "agentStatus" | "agentDelegate";
}

const STATE_CLASS: Record<TaskState, string> = {
  queued: "bg-bg-secondary text-text-secondary",
  working: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  input_required: "bg-yellow-500/20 text-yellow-800 dark:text-yellow-300",
  ready_for_review: "bg-accent/15 text-accent",
  done: "bg-green-500/15 text-green-700 dark:text-green-400",
  failed: "bg-red-500/15 text-red-700 dark:text-red-400",
  cancelled: "bg-bg-secondary text-text-tertiary",
};

// Second line under the badge, by state (what the person most needs to know).
export function taskSubtitle(task: TaskRow, run: RunRow | null, agentName: string | null): string {
  const stale = run?.stale_at ? `No signals for ${formatRelative(Date.parse(run.last_signal_at))}` : null;
  switch (task.state) {
    case "queued":
      if (!task.delegate_agent_id) return "no agent assigned";
      if (task.depends_on_task_ids.length) return `depends on ${task.depends_on_task_ids.length} task${task.depends_on_task_ids.length > 1 ? "s" : ""}`;
      return `for the next session with ${agentName ?? "the agent"}`;
    case "working":
      if (stale) return stale;
      if (task.review_rounds > 0) return `round ${task.review_rounds} of ${task.max_review_rounds}`;
      return task.last_activity_at ? formatRelative(Date.parse(task.last_activity_at)) : "just started";
    case "input_required":
      if (!task.delegate_agent_id) return "no agent assigned";
      return task.waiting_on === "lead" ? "waiting on the Lead" : "waiting on you";
    case "ready_for_review":
      if (task.review_state === "outdated") return "review outdated";
      if (task.review_state === "pending") return `Lead reviewing · round ${task.review_rounds + 1} of ${task.max_review_rounds}`;
      return task.brief_stale ? "brief changed after this run" : "deliverable ready";
    case "done":
      return task.acceptance === "accepted" ? "accepted" : task.acceptance === "rejected" ? "closed without accepting" : "closed";
    case "failed":
      return run?.error_message ? run.error_message.slice(0, 60) : "the run was declared unrecoverable";
    case "cancelled":
      return "press Continue to resume";
  }
}

export function StatusBadge({ task, run, agentName, compact = false }: { task: TaskRow; run: RunRow | null; agentName: string | null; compact?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={"rounded px-1.5 py-0.5 text-xs font-medium " + STATE_CLASS[task.state]}>{TASK_STATE_LABEL[task.state]}</span>
      {!compact && <span className="truncate text-xs text-text-tertiary">{taskSubtitle(task, run, agentName)}</span>}
    </span>
  );
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
  const agentName = task?.delegate_agent_id ? (agents.find((a) => a.id === task.delegate_agent_id)?.name ?? "Agent") : null;

  if (kind === "agentDelegate") {
    return <span className={"cell-readonly " + (agentName ? "" : "text-text-tertiary")} title={agentName ? "Assigned agent" : "Open the row to assign an agent"}>{agentName ?? "Unassigned"}</span>;
  }
  if (!task) return <span className="cell-readonly text-text-tertiary" title="Open the row to hand it to an agent">No task</span>;
  return (
    <span className="cell-readonly" title={taskSubtitle(task, run, agentName)}>
      <StatusBadge task={task} run={run} agentName={agentName} />
    </span>
  );
}
