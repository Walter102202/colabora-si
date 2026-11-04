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
  const counts = {
    accepted: subtasks.filter(({ task }) => task.state === "done" && task.acceptance === "accepted").length,
    closed: subtasks.filter(({ task }) => task.state === "done" && task.acceptance !== "accepted").length,
    failed: subtasks.filter(({ task }) => task.state === "failed").length,
    cancelled: subtasks.filter(({ task }) => task.state === "cancelled").length,
    review: subtasks.filter(({ task }) => task.state === "ready_for_review").length,
    working: subtasks.filter(({ task }) => task.state === "working").length,
    waiting: subtasks.filter(({ task }) => task.state === "input_required").length,
    queued: subtasks.filter(({ task }) => task.state === "queued").length,
  };
  const summary = [
    counts.accepted && `${counts.accepted} accepted`, counts.review && `${counts.review} in review`,
    counts.working && `${counts.working} working`, counts.waiting && `${counts.waiting} need input`,
    counts.queued && `${counts.queued} queued`, counts.closed && `${counts.closed} closed without accepting`,
    counts.failed && `${counts.failed} failed`, counts.cancelled && `${counts.cancelled} cancelled`,
  ].filter(Boolean).join(" · ");
  return (
    <section className="space-y-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
        Subtasks · {subtasks.length}
      </h4>
      <p aria-label="Subtask progress" className="text-xs leading-relaxed text-text-secondary">{summary}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {subtasks.map(({ task, run, agentName }) => (
          <li key={task.id}>
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left text-sm hover:bg-bg-secondary"
              onClick={() => onOpenTask(task.row_page_id, task.id)}
            >
              <span className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">{task.title || "Untitled subtask"}</span>
              <span className="shrink-0 text-xs text-text-tertiary">{agentName ?? "unassigned"}</span>
              <StatusBadge task={task} run={run} agentName={agentName} compact />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
