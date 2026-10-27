"use client";

import type { ActivityRow } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";

function summary(a: ActivityRow): string {
  const b = a.body;
  const pick = (k: string) => (typeof b[k] === "string" && b[k] ? (b[k] as string) : null);
  switch (a.type) {
    case "prompt":
      return `${pick("signal") ?? "message"}: ${pick("text") ?? ""}`;
    case "thought":
      return pick("text") ?? "";
    case "action":
      return pick("summary") ?? pick("op") ?? "action";
    case "elicitation":
      return `asked: ${pick("question") ?? ""}`;
    case "response":
      return pick("text") ?? "";
    case "error":
      return `error ${pick("code") ?? ""}: ${pick("message") ?? ""}`;
  }
}

const AUTHOR: Record<ActivityRow["author_type"], string> = { human: "You", agent: "Agent", system: "System" };

export function ActivityTimeline({ activities }: { activities: ActivityRow[] }) {
  if (activities.length === 0) return <p className="text-xs text-text-tertiary">No activity yet.</p>;
  return (
    <ol className="space-y-1 text-xs">
      {activities.map((a) => (
        <li key={a.id} className={"flex gap-2 " + (a.type === "error" ? "text-red-700 dark:text-red-400" : "")}>
          <span className="w-10 shrink-0 text-text-tertiary">#{a.seq}</span>
          <span className="w-14 shrink-0 text-text-secondary">{AUTHOR[a.author_type]}</span>
          <span className="min-w-0 flex-1 break-words">
            <span className="text-text-tertiary">{a.type} · </span>
            {summary(a)}
          </span>
          <span className="shrink-0 text-text-tertiary" title={a.created_at}>{formatRelative(Date.parse(a.created_at))}</span>
        </li>
      ))}
    </ol>
  );
}
