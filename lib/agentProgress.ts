import { isTerminal, waitsForAcceptance } from "@/lib/agentState";
import type { ApprovalRow, RunRow, TaskRow } from "@/lib/agentTasks";
import type { AutonomyLevel } from "@/lib/agentAutonomy";
import type { JobCiState } from "@/lib/agentCi";
import type { DbRow } from "@/lib/types";

export type ProgressTone = "neutral" | "active" | "attention" | "success" | "error";
export interface ProgressState { label: string; detail: string; tone: ProgressTone; needsYou: boolean; }
// Read-only presentation facts, not a prediction of whether the server will close a task.
export interface ProgressReviewContext {
  autonomy: AutonomyLevel | null;
  personCriteria: boolean | null;
  ciState: JobCiState | null;
}

// These labels describe server state. An accepted delivery says nothing about publication.
export function taskProgressState(task: TaskRow, run: RunRow | null, approvals: ApprovalRow[], userId: string | null, review?: ProgressReviewContext): ProgressState {
  const yours = !!userId && task.owner_user_id === userId;
  const pending = approvals.some((item) => item.task_id === task.id && item.status === "pending"
    && Date.parse(item.expires_at) > Date.now());
  if (!isTerminal(task.state) && pending) return { label: yours ? "Needs you" : "Needs a decision", detail: "An approval or question is waiting.", tone: "attention", needsYou: yours };
  if (task.state === "done") return task.acceptance === "accepted"
    ? { label: "Accepted", detail: "Delivery accepted. External actions have their own approvals and results.", tone: "success", needsYou: false }
    : { label: "Closed", detail: "Closed without an accepted delivery.", tone: "neutral", needsYou: false };
  if (task.state === "failed") return { label: "Failed", detail: run?.error_message || "The task needs attention before it can continue.", tone: "error", needsYou: false };
  if (task.state === "cancelled") return { label: "Stopped", detail: "The task is stopped. Its history and deliverables are kept.", tone: "neutral", needsYou: false };
  const personReview = task.state === "ready_for_review" && (review?.personCriteria === true
    || (!task.parent_task_id && waitsForAcceptance(task) && (review?.autonomy === "ask" || review?.autonomy === "balanced")));
  if (task.state === "input_required") {
    const human = task.waiting_on !== "lead" && task.waiting_on !== "agent";
    return { label: human ? yours ? "Needs you" : "Needs input" : task.waiting_on === "lead" ? "Waiting on Lead" : "Waiting on agent", detail: human ? "A person needs to answer before work can continue." : "The next step is with an agent.", tone: "attention", needsYou: yours && human };
  }
  if (task.review_state === "outdated" || task.brief_stale) return { label: "Review outdated", detail: "The brief or delivery changed. Check the current version before deciding.", tone: "attention", needsYou: yours && personReview };
  if (task.state === "ready_for_review") {
    if (personReview) return { label: yours ? "Needs your review" : "Ready for review", detail: review?.ciState === "pending"
      ? "Your review is needed. Acceptance is waiting for CI results."
      : review?.ciState === "failed" ? "Your review is needed. CI must pass before acceptance."
        : "A person's review is needed. Inspect the delivery and its current criteria before accepting.", tone: "attention", needsYou: yours };
    if (review?.personCriteria === false && (review.autonomy === "autonomous" || (task.parent_task_id && review.autonomy !== null))) {
      if (review.ciState === "pending") return { label: "Waiting for CI", detail: "CI has not confirmed a passing result for the delivered commit. The task remains open.", tone: "active", needsYou: false };
      if (review.ciState === "failed") return { label: "CI failed", detail: "The delivered commit has failing CI checks. The task remains open for the team to resolve them.", tone: "error", needsYou: false };
      return { label: "Waiting on Lead", detail: "The delivery is with the Lead for review or closure. Closure has not been confirmed.", tone: "active", needsYou: false };
    }
    return waitsForAcceptance(task)
      ? { label: "Ready for review", detail: "The delivery is saved. Review requirements have not been confirmed yet.", tone: "neutral", needsYou: false }
      : { label: "Lead reviewing", detail: "The delivery is waiting for its review.", tone: "active", needsYou: false };
  }
  if (run?.stale_at) return { label: "No recent signal", detail: "The last run has not reported recently. Its saved work is still here.", tone: "attention", needsYou: false };
  if (task.review_state === "changes_requested") return { label: "Changes requested", detail: "Feedback is recorded. The next delivery still needs review.", tone: "active", needsYou: false };
  if (task.state === "working") return { label: "Working", detail: "An agent is working on this task.", tone: "active", needsYou: false };
  return { label: task.delegate_agent_id ? "Queued" : "Needs an agent", detail: task.delegate_agent_id ? "Waiting for the assigned agent to take the task." : "Open the page to choose an agent.", tone: "neutral", needsYou: yours && !task.delegate_agent_id };
}

export function progressActivityAt(task: TaskRow | null | undefined): number | undefined {
  for (const value of [task?.last_activity_at, task?.updated_at, task?.created_at]) {
    const at = value ? Date.parse(value) : NaN;
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

export interface ProgressRow { row: DbRow; depth: number; ancestors: string[]; contextOnly: boolean; activityAt?: number; }

// Filtered children retain their parent as context. Every matching row stays accessible,
// even when its task is old, not yet loaded, or its parent is missing.
export function progressRows(rows: DbRow[], allRows: DbRow[], activityByRow?: ReadonlyMap<string, number | undefined>): ProgressRow[] {
  const byId = new Map(allRows.map((row) => [row.id, row]));
  for (const row of rows) byId.set(row.id, row);
  // A Worker's activity belongs to the whole job. Sort groups and siblings by
  // that same date without changing the database's saved order or hierarchy.
  const recent = new Map<string, number>();
  if (activityByRow) for (const row of byId.values()) {
    const at = activityByRow.get(row.id);
    if (at === undefined || !Number.isFinite(at)) continue;
    const seen = new Set<string>();
    let id: string | undefined = row.id;
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      if (!recent.has(id) || at > recent.get(id)!) recent.set(id, at);
      id = byId.get(id)?.parentRowId ?? undefined;
    }
  }
  const matching = new Set(rows.map((row) => row.id));
  const included = new Set(matching);
  for (const row of rows) {
    const seen = new Set([row.id]);
    let parent = row.parentRowId;
    while (parent && byId.has(parent) && !seen.has(parent)) {
      included.add(parent); seen.add(parent); parent = byId.get(parent)?.parentRowId;
    }
  }
  const ordered = [...rows, ...allRows.filter((row) => !matching.has(row.id))].filter((row) => included.has(row.id));
  if (activityByRow) ordered.sort((a, b) => {
    const left = recent.get(a.id), right = recent.get(b.id);
    if (left === right) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return right - left;
  });
  const children = new Map<string, DbRow[]>();
  for (const row of ordered) {
    if (!row.parentRowId || !included.has(row.parentRowId) || row.parentRowId === row.id) continue;
    children.set(row.parentRowId, [...(children.get(row.parentRowId) ?? []), row]);
  }
  const result: ProgressRow[] = [], visited = new Set<string>();
  const visit = (row: DbRow, ancestors: string[]) => {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    result.push({ row, depth: ancestors.length, ancestors, contextOnly: !matching.has(row.id), activityAt: recent.get(row.id) });
    for (const child of children.get(row.id) ?? []) visit(child, [...ancestors, row.id]);
  };
  for (const row of ordered) if (!row.parentRowId || !included.has(row.parentRowId)) visit(row, []);
  for (const row of ordered) if (!visited.has(row.id)) visit(row, []);
  return result;
}

export type ProgressReadMarkers = Record<string, string>;
export function progressReadKey(workspaceId: string, userId: string, databaseId: string): string {
  return `colabora-progress-read:v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(userId)}:${encodeURIComponent(databaseId)}`;
}
export function parseProgressReadMarkers(raw: string | null): ProgressReadMarkers {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, at]) => id.length > 0 && typeof at === "string" && Number.isFinite(Date.parse(at))).slice(0, 500));
  } catch { return {}; }
}
export function updatedSinceRead(task: TaskRow, markers: ProgressReadMarkers): boolean {
  const at = markers[task.id];
  return !!at && Date.parse(task.last_activity_at ?? task.updated_at) > Date.parse(at);
}
