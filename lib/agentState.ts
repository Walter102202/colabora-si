import { describeApproval } from "@/lib/agentApprovalText";
// Pure task state machine and the copy shown next to agent actions.
// No I/O: the server derives state; this module predicts and explains it.

export type TaskState = "queued" | "working" | "input_required" | "ready_for_review" | "done" | "failed" | "cancelled";
export type RunStatus = "running" | "waiting" | "completed" | "error" | "cancelled";
export type Acceptance = "pending" | "accepted" | "rejected";

export type TaskEvent =
  | "claim"
  | "input_needed"
  | "decide"
  | "feedback"
  | "continue"
  | "submit"
  | "changes_requested"
  | "blocked"
  | "close"
  | "run_error"
  | "retries_exhausted"
  | "revoked"
  | "budget_exhausted"
  | "stop"
  | "stop_acked"
  | "retry"
  | "reopen";

export interface TaskLike {
  state: TaskState;
  active_run_id?: string | null;
  brief_version?: number;
}

export interface AgentLike {
  name: string;
  capabilities?: Record<string, boolean> | null;
}

export const TERMINAL_STATES: readonly TaskState[] = ["done", "failed", "cancelled"];

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

// Transition table. A pair of targets means "with an active run" / "without one".
const TRANSITIONS: Record<TaskState, Partial<Record<TaskEvent, TaskState | [TaskState, TaskState]>>> = {
  queued: { claim: "working", revoked: "failed", budget_exhausted: "failed", stop: "cancelled" },
  working: {
    input_needed: "input_required",
    submit: "ready_for_review",
    run_error: "failed",
    retries_exhausted: "failed",
    stop_acked: "cancelled",
  },
  input_required: {
    decide: ["working", "queued"],
    feedback: ["working", "queued"],
    continue: ["working", "queued"],
    stop: "cancelled",
  },
  ready_for_review: {
    changes_requested: ["working", "queued"],
    blocked: "input_required",
    close: "done",
    stop: "cancelled",
  },
  done: { continue: "queued" },
  failed: { retry: "queued" },
  cancelled: { reopen: "queued" },
};

export function canTransition(state: TaskState, event: TaskEvent): boolean {
  return TRANSITIONS[state]?.[event] !== undefined;
}

// Mirror of close_task (0014): a person accepts a deliverable in review, or one that waits on them after a blocked or
// escalated review. Closing without accepting is allowed in both states with or without a deliverable.
export function canAcceptAndClose(state: TaskState, hasDeliverable: boolean): boolean {
  return state === "ready_for_review" || (state === "input_required" && hasDeliverable);
}

export function nextState(task: TaskLike, event: TaskEvent): TaskState | null {
  const target = TRANSITIONS[task.state]?.[event];
  if (target === undefined) return null;
  if (Array.isArray(target)) return task.active_run_id ? target[0] : target[1];
  return target;
}

export interface ContinuationPlan {
  kind: "message" | "reopen" | "queued";
  text: string;
}

// What pressing Continue does to this task, given the agent's declared capabilities.
export function continuationPlan(task: TaskLike, agent: AgentLike | null): ContinuationPlan {
  if (isTerminal(task.state)) {
    return { kind: "reopen", text: "Reopens the task with a new run. History and deliverables are kept." };
  }
  if (task.active_run_id) {
    return { kind: "queued", text: `A run is active. The message is queued and ${agent?.name ?? "the agent"} reads it on its next signal.` };
  }
  return { kind: "message", text: whatWillHappen(task, agent, "continue") };
}

export type UiAction =
  | "continue"
  | "stop"
  | "approve"
  | "undo"
  | "restore"
  | "pause_agent"
  | "disable_agent"
  | "revoke_token";

export interface ActionDetail {
  action?: string;
  params?: Record<string, unknown>;
  artifactVersion?: number | null;
  expiresIn?: string;
  runLabel?: string;
}

// "What will happen when you press this" copy.
export function whatWillHappen(task: TaskLike, agent: AgentLike | null, action: UiAction, detail: ActionDetail = {}): string {
  switch (action) {
    case "continue": {
      if (isTerminal(task.state)) return "Reopens the task with a new run. History and deliverables are kept.";
      const caps = agent?.capabilities ?? null;
      const name = agent?.name ?? "the agent";
      if (!caps || Object.keys(caps).length === 0) {
        return "The connection did not declare capabilities. Continue stays queued until the next session.";
      }
      if (caps.continue) {
        const brief = task.brief_version ? ` with brief v${task.brief_version}` : "";
        const deliverable = detail.artifactVersion ? ` and deliverable v${detail.artifactVersion}` : "";
        return `Dispatches to ${name}${brief}${deliverable}. Acknowledged in seconds. If a run is active, it queues.`;
      }
      if (caps.events) return "Sends it to the subscribed chat. If there is no active subscription, it stays queued.";
      return `Stays queued. ${name} will see it in your next conversation with list_my_tasks.`;
    }
    case "stop":
      return "Sends stop and waits for the run to acknowledge. Nothing is reverted.";
    case "approve": {
      const d = describeApproval(detail.action ?? null, detail.params ?? {}, { artifactVersion: detail.artifactVersion ?? null });
      const expires = detail.expiresIn ? ` Expires in ${detail.expiresIn}.` : "";
      return `${d.what}. ${d.effect}${expires}`;
    }
    case "undo":
      return `Reverts the blocks and cells that ${detail.runLabel ?? "this run"} touched and nobody edited after. Everything else stays visible as a conflict.`;
    case "restore":
      return "Replaces the whole page with the chosen version, including your later edits.";
    case "pause_agent":
      return "Stops reading and writing on its next call. Open connections can take up to 1 hour to drop.";
    case "disable_agent":
      return "Loses access to everything. Its open tasks are left without an agent.";
    case "revoke_token":
      return "The harness stops authenticating. An already exchanged token stays valid for up to 1 hour.";
  }
}

// Badge copy.
export const TASK_STATE_LABEL: Record<TaskState, string> = {
  queued: "Queued",
  working: "Working",
  input_required: "Needs your decision",
  ready_for_review: "Ready for review",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: "Working",
  waiting: "Waiting",
  completed: "Finished",
  error: "Error",
  cancelled: "Interrupted",
};

export function acceptanceLabel(acceptance: Acceptance, by?: string | null): string {
  if (acceptance === "accepted") return by ? `Accepted by ${by}` : "Accepted";
  if (acceptance === "rejected") return by ? `Rejected by ${by}` : "Rejected";
  return "Pending acceptance";
}

export const AGENT_ERRORS = {
  approval_needs_direct_session: "You cannot approve from this connection. Open the app in the browser to decide.",
  approval_consumed: "This approval was already used or expired. The agent has to ask again.",
  stop_not_acked: "The agent did not answer the stop in 30 s. It may keep working. You can pause it from Agents.",
  block_conflict: "You and the agent edited the same block. Choose which version stays.",
  agent_paused: "This agent is paused. It cannot read or write until you resume it.",
  token_revoked: "Token revoked. Generate a new one and update the harness configuration.",
  no_capabilities: "The connection did not declare capabilities. Continue stays queued until the next session.",
  agent_cannot_read_row: "This agent cannot read this row. Give it access before assigning.",
  page_locked: "This page is locked. The agent cannot write here.",
  offline: "No connection. Agents need you to sign in.",
  budget_exhausted: "Monthly budget used up. The agent will not receive new tasks until you raise it.",
  composer_no_mention: "Without an @Agent this stays a comment and wakes nobody.",
} as const;
