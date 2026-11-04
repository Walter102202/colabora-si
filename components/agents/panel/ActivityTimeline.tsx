import type { ActivityRow } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";
import { activityAuthor, activityLabel } from "@/lib/agentTaskText";
import { progressAuthor } from "@/lib/agentProgressActivity";

export function ActivityTimeline({ activities, agentNames = {}, taskNames = {}, userId }: {
  activities: ActivityRow[];
  agentNames?: Record<string, string>;
  taskNames?: Record<string, string>;
  userId?: string | null;
}) {
  if (activities.length === 0) return <p className="text-xs text-text-tertiary">No activity yet.</p>;
  const ordered = [...activities].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.seq - b.seq || a.id.localeCompare(b.id));
  return (
    <ol className="space-y-2 text-xs">
      {ordered.map((a) => (
        <li key={a.id} className={"flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md bg-bg-secondary p-2 " + (a.type === "error" ? "text-red-700 dark:text-red-400" : "")}>
          <span className="shrink-0 text-text-tertiary">#{a.seq}</span>
          <span className="break-words text-text-secondary">{userId === undefined ? activityAuthor(a.author_type, a.author_id, agentNames) : progressAuthor(a.author_type, a.author_id, agentNames, userId)}</span>
          {taskNames[a.task_id] && <span className="min-w-0 break-words text-text-tertiary">· {taskNames[a.task_id]}</span>}
          <time dateTime={a.created_at} className="ml-auto shrink-0 text-text-tertiary" title={a.created_at}>{formatRelative(Date.parse(a.created_at))}</time>
          <span className="min-w-0 basis-full whitespace-pre-wrap break-words leading-relaxed">
            <span className="text-text-tertiary">{a.type} · </span>
            {activityLabel(a)}
          </span>
        </li>
      ))}
    </ol>
  );
}
