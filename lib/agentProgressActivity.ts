import type { ActivityRow, ReviewRow, TaskRow } from "@/lib/agentTasks";
import { activityLabel } from "@/lib/agentTaskText";

export interface ProgressMilestone {
  id: string;
  taskId: string;
  pageId: string;
  taskTitle: string;
  createdAt: string;
  label: string;
  detail: string;
  author: string;
  source: "activity" | "review";
  seq: number;
}

export interface ProgressActivityInput {
  task: TaskRow;
  subtasks: TaskRow[];
  activities: ActivityRow[];
  reviews: ReviewRow[];
  agentNames: Record<string, string>;
  userId?: string | null;
}

export function progressAuthor(type: ActivityRow["author_type"], id: string, names: Record<string, string>, userId?: string | null): string {
  if (type === "human") return userId && userId === id ? "You" : "A teammate";
  return type === "system" ? "System" : names[id] ?? "Unknown agent";
}

const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const at = (value: string): number => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

// An allowlist of recorded milestones. Routine row/block operations remain in
// the original activity, without becoming evidence of delivery or completion.
function activityMilestone(activity: ActivityRow): { label: string; detail: string } | null {
  const body = activity.body;
  const text = string(body.text);
  switch (activity.type) {
    case "response":
      return body.submit === true ? { label: "Submitted for review", detail: text || "The agent submitted its work for review." } : null;
    case "elicitation":
      return { label: string(body.action) ? "Approval requested" : "Input requested", detail: string(body.question) || activityLabel(activity) };
    case "error":
      return { label: "Error reported", detail: activityLabel(activity) };
    case "checkpoint":
      return { label: "Checkpoint saved", detail: [text, string(body.summary), string(body.next_step)].filter(Boolean).join("\n") || activityLabel(activity) };
    case "handover":
      return { label: "Task handed over", detail: activityLabel(activity) };
    case "prompt": {
      if (body.close === "accepted") return { label: "Delivery accepted", detail: text || "The delivery was accepted in the workspace." };
      if (body.close === "rejected") return { label: "Closed without accepting", detail: text || "The task was closed without accepting its delivery." };
      if (body.source === "lease") return { label: "Session needs attention", detail: activityLabel(activity) };
      if (body.signal === "stop") return { label: "Stop requested", detail: text || "A stop was requested; the run must acknowledge it." };
      if (body.signal === "continue") return { label: "Continuation requested", detail: text || "The agent was asked to continue." };
      return text ? { label: "Feedback sent", detail: text } : null;
    }
    case "action": {
      const labels: Record<string, string> = {
        claim: "Work started",
        start: "Run started",
        create_subtask: "Subtask created",
        import_plan: "Plan updated",
        update_subtask: "Subtask updated",
        update_brief: "Brief updated",
        add_artifact: "Deliverable recorded",
        submit_for_review: "Submitted for review",
        request_approval: "Approval requested",
        review: "Review recorded",
        auto_approval: "Action approved automatically",
        revert_run: "Revert recorded",
        external: "External action reported",
      };
      const label = labels[string(body.op)];
      return label ? { label, detail: activityLabel(activity) } : null;
    }
    default: return null;
  }
}

// Ascending, stable event order. Callers may show the last item as the latest
// milestone, but should not describe this loaded slice as the complete history.
export function buildProgressMilestones({ task, subtasks, activities, reviews, agentNames, userId }: ProgressActivityInput): ProgressMilestone[] {
  const tasks = new Map([task, ...subtasks.filter((row) => row.parent_task_id === task.id)].map((row) => [row.id, row]));
  const relevantReviews = reviews.filter((review) => tasks.has(review.task_id));
  const reviewIds = new Set(relevantReviews.map((review) => review.id));
  const submissions = new Set(activities.filter((activity) => activity.type === "response" && activity.body.submit === true && activity.run_id)
    .map((activity) => `${activity.task_id}:${activity.run_id}`));
  const milestones = new Map<string, ProgressMilestone>();
  for (const activity of activities) {
    const row = tasks.get(activity.task_id);
    if (!row || reviewIds.has(string(activity.body.review_id))) continue;
    if (activity.type === "action" && activity.body.op === "submit_for_review" && activity.run_id && submissions.has(`${activity.task_id}:${activity.run_id}`)) continue;
    const event = activityMilestone(activity);
    if (!event) continue;
    const id = `activity:${activity.id}`;
    milestones.set(id, {
      id, taskId: row.id, pageId: row.row_page_id, taskTitle: row.title,
      createdAt: activity.created_at, ...event,
      author: progressAuthor(activity.author_type, activity.author_id, agentNames, userId),
      source: "activity", seq: activity.seq,
    });
  }
  const labels: Record<ReviewRow["verdict"], string> = { approved: "Delivery approved", changes_requested: "Changes requested", blocked: "Review blocked" };
  for (const review of relevantReviews) {
    const row = tasks.get(review.task_id)!;
    const version = `Deliverable v${review.artifact_version ?? "?"} · brief v${review.brief_version ?? "?"}`;
    const outdated = review.outdated_by ? `Review outdated: the ${review.outdated_by === "artifact" ? "deliverable" : "brief"} changed after this review.` : "";
    const findings = (review.findings ?? []).map((finding) => [
      finding.severity === "minor" ? "Minor note" : finding.criterion_id,
      finding.status.replaceAll("_", " "), finding.note, finding.evidence_ref,
    ].filter(Boolean).join(" · "));
    const evidence = (review.evidence ?? []).map((item) => `${item.kind}: ${item.ref}${item.hash ? ` (${item.hash})` : ""}`);
    const id = `review:${review.id}`;
    milestones.set(id, {
      id, taskId: row.id, pageId: row.row_page_id, taskTitle: row.title, createdAt: review.created_at,
      label: labels[review.verdict], detail: [version, outdated, ...findings, ...evidence].filter(Boolean).join("\n"),
      author: progressAuthor(review.reviewer_type, review.reviewer_id, agentNames, userId), source: "review", seq: 0,
    });
  }
  return [...milestones.values()].sort((a, b) => at(a.createdAt) - at(b.createdAt) || (a.taskId === b.taskId ? a.seq - b.seq : 0) || a.id.localeCompare(b.id));
}
