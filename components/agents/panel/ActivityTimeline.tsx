import type { ActivityRow } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";
import { activityAuthor, activityLabel } from "@/lib/agentTaskText";

export function ActivityTimeline({ activities, agentNames = {} }: { activities: ActivityRow[]; agentNames?: Record<string, string> }) {
  if (activities.length === 0) return <p className="text-xs text-text-tertiary">No activity yet.</p>;
  return (
    <ol className="space-y-1 text-xs">
      {activities.map((a) => (
        <li key={a.id} className={"flex gap-2 " + (a.type === "error" ? "text-red-700 dark:text-red-400" : "")}>
          <span className="w-10 shrink-0 text-text-tertiary">#{a.seq}</span>
          <span className="w-24 shrink-0 break-words text-text-secondary">{activityAuthor(a.author_type, a.author_id, agentNames)}</span>
          <span className="min-w-0 flex-1 break-words">
            <span className="text-text-tertiary">{a.type} · </span>
            {activityLabel(a)}
          </span>
          <span className="shrink-0 text-text-tertiary" title={a.created_at}>{formatRelative(Date.parse(a.created_at))}</span>
        </li>
      ))}
    </ol>
  );
}
