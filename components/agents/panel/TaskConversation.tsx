import type { ActivityRow, ReviewRow, TaskRow } from "@/lib/agentTasks";
import { activityAuthor, activityLabel } from "@/lib/agentTaskText";

export interface ConversationData { activities: ActivityRow[]; reviews: ReviewRow[]; }

export function TaskConversation({ task, subtasks, activities, reviews, agentNames }: ConversationData & {
  task: TaskRow; subtasks: TaskRow[]; agentNames: Record<string, string>;
}) {
  const tasks = new Map([task, ...subtasks].map((row) => [row.id, row]));
  const recipient = (row: TaskRow, authorId: string) => {
    const target = row.parent_task_id === task.id && authorId === row.delegate_agent_id ? task : row;
    const name = target.delegate_agent_id ? agentNames[target.delegate_agent_id] ?? target.title : target.title;
    return row.id === task.id ? name : `${name} (${row.title})`;
  };
  const lines = activities.flatMap((activity) => {
    const row = tasks.get(activity.task_id);
    const visible = ["prompt", "response", "thought", "checkpoint"].includes(activity.type)
      || (activity.type === "action" && typeof activity.body.summary === "string" && activity.body.op !== "review");
    if (!row || !visible) return [];
    const text = typeof activity.body.text === "string" ? activity.body.text : activityLabel(activity);
    if (!text.trim()) return [];
    return [{ id: activity.id, at: activity.created_at, seq: activity.seq,
      text: `${activityAuthor(activity.author_type, activity.author_id, agentNames)}${activity.type === "prompt" && activity.author_type === "human" && activity.body.source === "trama" ? " (via Trama)" : ""} → ${recipient(row, activity.author_id)}: ${text}` }];
  });
  for (const review of reviews) {
    const row = tasks.get(review.task_id);
    if (!row) continue;
    const verdict = { approved: "Approved", changes_requested: "Changes requested", blocked: "Blocked" }[review.verdict];
    const findings = review.findings.map((finding) => [finding.criterion_id, finding.status.replaceAll("_", " "), finding.note, finding.evidence_ref].filter(Boolean).join(" — ")).join("; ");
    lines.push({ id: `review:${review.id}`, at: review.created_at, seq: 0,
      text: `${activityAuthor(review.reviewer_type, review.reviewer_id, agentNames)} → ${recipient(row, review.reviewer_id)}: ${verdict}${findings ? `: ${findings}` : ""}` });
  }
  lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq || a.id.localeCompare(b.id));
  return <section aria-label="Conversation" className="space-y-2">
    <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Conversation</h4>
    {lines.length ? <ol className="space-y-2 text-xs">{lines.map((line) => <li key={line.id} className="flex gap-2">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line.text}</span>
      <time dateTime={line.at} title={line.at} className="shrink-0 text-text-tertiary">{new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
    </li>)}</ol> : <p className="text-xs text-text-tertiary">No messages yet.</p>}
  </section>;
}
