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

const truncate = (text: string) => text.length > 180 ? `${text.slice(0, 179)}…` : text;

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
  return { id: `notification:${n.id}`, kind: n.kind, title: truncate(title), body: truncate(body), url: notificationPath(n) ?? "/" };
}

export function shouldPush(n: AgentNotification, approval: PushApproval | null): boolean {
  return !n.approval_id || !approval || approval.status === "pending";
}
