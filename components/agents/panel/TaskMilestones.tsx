import { useState } from "react";
import type { ProgressMilestone } from "@/lib/agentProgressActivity";

const RECENT_COUNT = 8;

export function TaskMilestones({ milestones, taskId, onOpenTask }: {
  milestones: ProgressMilestone[];
  taskId: string;
  onOpenTask: (pageId: string, taskId: string) => void;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const visible = showEarlier ? milestones : milestones.slice(-RECENT_COUNT);
  return <section aria-label="Milestones" className="space-y-3">
    <div>
      <h4 className="text-sm font-medium">Milestones</h4>
      <p className="mt-1 text-xs text-text-secondary">Deliveries, reviews, decisions and blockers from the loaded activity.</p>
    </div>
    {milestones.length > RECENT_COUNT && <button type="button" className="rounded px-2 py-1 text-xs text-accent hover:bg-bg-secondary" aria-expanded={showEarlier} onClick={() => setShowEarlier((value) => !value)}>
      {showEarlier ? "Show recent milestones" : `Show ${milestones.length - RECENT_COUNT} earlier milestones`}
    </button>}
    {visible.length ? <ol className="space-y-3 border-l border-border pl-4">
      {visible.map((milestone) => <li key={milestone.id} className="relative min-w-0">
        <span aria-hidden="true" className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-accent" />
        <details className="group rounded-md border border-border bg-bg p-3">
          <summary className="cursor-pointer text-sm font-medium marker:text-text-tertiary">
            {milestone.label}
            <span className="ml-2 font-normal text-text-secondary">· {milestone.author}</span>
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary">{milestone.detail}</p>
        </details>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-text-tertiary">
          {milestone.taskId !== taskId ? <button type="button" className="min-w-0 truncate text-accent hover:underline" title={milestone.taskTitle} onClick={() => onOpenTask(milestone.pageId, milestone.taskId)}>{milestone.taskTitle || "Open subtask"}</button> : <span>This task</span>}
          {Number.isFinite(Date.parse(milestone.createdAt)) && <time dateTime={milestone.createdAt} title={milestone.createdAt}>{new Date(milestone.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>}
        </div>
      </li>)}
    </ol> : <p className="text-sm text-text-tertiary">No milestones in the loaded activity yet. The messages and original events are available below.</p>}
  </section>;
}
