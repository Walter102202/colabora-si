"use client";

import type { ActivityRow } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";

/** Readable names for the control actions the server logs without a summary. */
const OP_LABEL: Record<string, string> = {
  claim: "Claimed the task",
  start: "Started a run",
  heartbeat: "Heartbeat",
  submit_for_review: "Submitted for review",
  request_approval: "Asked for an approval",
  add_artifact: "Declared a deliverable",
  create_subtask: "Created a subtask",
  review: "Reviewed the deliverable",
};

/** One line for an activity: what happened, in words a person reads in the panel. */
export function activityLabel(a: ActivityRow): string {
  const b = a.body;
  const pick = (k: string) => (typeof b[k] === "string" && b[k] ? (b[k] as string) : null);
  switch (a.type) {
    case "prompt": {
      const close = pick("close");
      if (close) return `closed as ${close}${pick("text") ? `: ${pick("text")}` : ""}`;
      return `${pick("signal") ?? "message"}: ${pick("text") ?? ""}`;
    }
    case "thought":
      return pick("text") ?? "";
    case "action": {
      const op = pick("op");
      return pick("summary") ?? (op ? OP_LABEL[op] ?? op : "action");
    }
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
            {activityLabel(a)}
          </span>
          <span className="shrink-0 text-text-tertiary" title={a.created_at}>{formatRelative(Date.parse(a.created_at))}</span>
        </li>
      ))}
    </ol>
  );
}
