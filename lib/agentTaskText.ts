import type { ActivityRow, RunRow, TaskRow } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";

// Short texts derived from a task or an approval, shared by the cells, the
// panel and any surface that renders a task outside the workspace.

// Second line under the status badge, by state (what the person most needs to know).
export function taskSubtitle(task: TaskRow, run: RunRow | null, agentName: string | null): string {
  const stale = run?.stale_at ? `No signals for ${formatRelative(Date.parse(run.last_signal_at))}` : null;
  switch (task.state) {
    case "queued":
      if (!task.delegate_agent_id) return "no agent assigned";
      if (task.depends_on_task_ids.length) return `depends on ${task.depends_on_task_ids.length} task${task.depends_on_task_ids.length > 1 ? "s" : ""}`;
      return `for the next session with ${agentName ?? "the agent"}`;
    case "working":
      if (stale) return stale;
      if (task.review_rounds > 0) return `round ${task.review_rounds} of ${task.max_review_rounds}`;
      return task.last_activity_at ? formatRelative(Date.parse(task.last_activity_at)) : "just started";
    case "input_required":
      if (!task.delegate_agent_id) return "no agent assigned";
      return task.waiting_on === "lead" ? "waiting on the Lead" : "waiting on you";
    case "ready_for_review":
      if (task.review_state === "outdated") return "review outdated";
      if (task.review_state === "pending") return `Lead reviewing · round ${task.review_rounds + 1} of ${task.max_review_rounds}`;
      return task.brief_stale ? "brief changed after this run" : "deliverable ready";
    case "done":
      return task.acceptance === "accepted" ? "accepted" : task.acceptance === "rejected" ? "closed without accepting" : "closed";
    case "failed":
      return run?.error_message ? run.error_message.slice(0, 60) : "the run was declared unrecoverable";
    case "cancelled":
      return "press Continue to resume";
  }
}

// How long until an approval expires, in the coarsest useful unit.
export function expiresIn(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "expired";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

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
