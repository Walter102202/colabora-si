import type { RunRow, TaskRow } from "@/lib/agentTasks";
import { StatusBadge } from "@/components/agents/panel/StatusBadge";

export interface SubtaskItem {
  task: TaskRow;
  run: RunRow | null;
  agentName: string | null;
}

// Subtasks a Lead opened under a task, with their state and worker. Pure:
// the caller resolves runs and agent names and handles the navigation.
export function SubtaskList({ subtasks, onOpenTask }: { subtasks: SubtaskItem[]; onOpenTask: (pageId: string, taskId: string) => void }) {
  if (subtasks.length === 0) return null;
  const open = subtasks.filter(({ task }) => !["done", "failed", "cancelled"].includes(task.state)).length;
  return (
    <section className="space-y-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
        Subtasks · {subtasks.length - open} of {subtasks.length} closed
      </h4>
      <ul className="divide-y divide-border rounded-md border border-border">
        {subtasks.map(({ task, run, agentName }) => (
          <li key={task.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-bg-secondary"
              onClick={() => onOpenTask(task.row_page_id, task.id)}
            >
              <span className="min-w-0 flex-1 truncate">{task.title || "Untitled subtask"}</span>
              <span className="shrink-0 text-xs text-text-tertiary">{agentName ?? "unassigned"}</span>
              <StatusBadge task={task} run={run} agentName={agentName} compact />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
