import type { RunRow, TaskRow } from "@/lib/agentTasks";
import { TASK_STATE_LABEL, type TaskState } from "@/lib/agentState";
import { taskSubtitle } from "@/lib/agentTaskText";

const STATE_CLASS: Record<TaskState, string> = {
  queued: "bg-bg-secondary text-text-secondary",
  working: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  input_required: "bg-yellow-500/20 text-yellow-800 dark:text-yellow-300",
  ready_for_review: "bg-accent/15 text-accent",
  done: "bg-green-500/15 text-green-700 dark:text-green-400",
  failed: "bg-red-500/15 text-red-700 dark:text-red-400",
  cancelled: "bg-bg-secondary text-text-tertiary",
};

// State of a task as a badge, with the one-line subtitle unless compact.
export function StatusBadge({ task, run, agentName, compact = false }: { task: TaskRow; run: RunRow | null; agentName: string | null; compact?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={"rounded px-1.5 py-0.5 text-xs font-medium " + STATE_CLASS[task.state]}>{TASK_STATE_LABEL[task.state]}</span>
      {!compact && <span className="truncate text-xs text-text-tertiary">{taskSubtitle(task, run, agentName)}</span>}
    </span>
  );
}
