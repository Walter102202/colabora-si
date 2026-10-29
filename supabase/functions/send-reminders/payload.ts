// Title, body and link of an agent notification push: the action as describeApproval words it,
// the question as the agent asked it, or a fixed sentence; never a summary written by the model.
import { describeApproval } from "../_shared/lib/agentApprovalText.ts";
import { notificationPath } from "../_shared/lib/agentLinks.ts";

export interface AgentNotification {
  id: string;
  kind: string;
  page_id: string | null;
  task_id: string | null;
  approval_id: string | null;
  block_id: string | null;
  payload: Record<string, unknown> | null;
}

export interface PushApproval {
  action: string | null;
  params: Record<string, unknown> | null;
  artifact_version: number | null;
  question: string | null;
  kind: string;
  blocking: boolean | null;
  status: string;
}

export interface PushPayload {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string;
}

// Control characters become spaces and the cut never splits a character, so a push never shows "�".
const truncate = (text: string) => {
  const chars = Array.from(text, (c) => (c < " " || c === "\u007f" ? " " : c));
  return chars.length > 180 ? `${chars.slice(0, 179).join("")}…` : chars.join("");
};

// Web Push carries at most 4096 bytes. Title and body stay under 1.5 KB, so a longer link opens the home page instead.
const MAX_URL = 1500;

export function agentPush(n: AgentNotification, taskTitle: string | null, approval: PushApproval | null): PushPayload {
  const task = taskTitle || "a task";
  let title: string;
  let body: string;
  switch (n.kind) {
    case "approval_requested":
      title = `Approval needed: ${task}`;
      body = approval?.kind === "action"
        ? describeApproval(approval.action, approval.params ?? {}, { artifactVersion: approval.artifact_version }).what
        : approval?.question || "An agent asks for your approval.";
      break;
    case "input_required":
      if (n.payload?.handover === true) {
        title = `Handed over: ${task}`;
        body = "The agent handed the task over. Open it to continue.";
      } else {
        title = `${approval?.blocking === false ? "Question (the agent keeps working)" : "Question"}: ${task}`;
        body = approval?.question || "An agent needs your input.";
      }
      break;
    case "ready_for_review":
      title = `Ready for review: ${task}`;
      body = "The agent delivered. Review it and close the task.";
      break;
    case "task_failed":
      title = `Task failed: ${task}`;
      body = "The agent could not finish. Open the task to see why.";
      break;
    default:
      title = task;
      body = n.kind.replace(/_/g, " ");
  }
  const url = notificationPath(n) ?? "/";
  return { id: `notification:${n.id}`, kind: n.kind, title: truncate(title), body: truncate(body), url: url.length > MAX_URL ? "/" : url };
}

export function shouldPush(n: AgentNotification, approval: PushApproval | null): boolean {
  return !n.approval_id || !approval || approval.status === "pending";
}

// After one pass over a person's subscriptions: delivered, worth another try, or never deliverable.
export type PushOutcome = "delivered" | "retry" | "drop";

export function pushOutcome(results: (number | "threw")[]): PushOutcome {
  if (results.some((r) => typeof r === "number" && r >= 200 && r < 300)) return "delivered";
  // A 4xx other than 429 fails the same way every time: an expired endpoint (404, 410), keys the push
  // service rejects (400, 401, 403) or a payload that is too large (413).
  const permanent = (r: number | "threw") => typeof r === "number" && r >= 400 && r < 500 && r !== 429;
  return results.length > 0 && results.every(permanent) ? "drop" : "retry";
}

// sendPush asks the push service to keep a message for 24 hours; a notification older than that is not
// pushed any more (the inbox still shows it), so a push that keeps failing leaves the queue.
export const PUSH_TTL_MS = 86_400_000;

export function tooOldToPush(createdAt: string, now: number): boolean {
  return now - Date.parse(createdAt) > PUSH_TTL_MS;
}
