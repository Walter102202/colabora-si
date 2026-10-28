import type { ActivityRow, ApprovalRow, ArtifactRow, BriefRow, ReviewRow, RunRow, TaskRow } from "@/lib/agentTasks";
import type { AgentRole } from "@/lib/agentsStore";
import { pageUrl, taskUrl } from "@/lib/routes";

// Data contract of the MCP Apps task card. The mcp function returns one of
// these shapes as `structuredContent` of get_task, decide_approval, close_task
// and list_waiting_on_me; the host hands it to the card untouched. Snake_case
// on the wire, like every other tool result.

export interface CardAgent {
  id: string;
  name: string;
  role: AgentRole;
  capabilities: Record<string, boolean>;
}

export interface CardSubtask {
  task: TaskRow;
  run: RunRow | null;
  agent_name: string | null;
}

export interface TaskCardData {
  kind: "task";
  task: TaskRow;
  run: RunRow | null;
  approval: ApprovalRow | null;
  artifact: ArtifactRow | null;
  review: ReviewRow | null;
  brief: BriefRow | null;
  // Last activities, oldest first (non-ephemeral).
  activities: ActivityRow[];
  subtasks: CardSubtask[];
  // Agents referenced by the task, its subtasks and the review, when the caller may read them.
  agents: CardAgent[];
  // Public URL of the web app, without a trailing slash; empty when the server has none.
  app_url: string;
}

export type WaitingReason = "approval" | "input" | "review";

export interface WaitingApproval {
  id: string;
  kind: ApprovalRow["kind"];
  action: string | null;
  question: string;
  options: ApprovalRow["options"];
  expires_at: string;
}

export interface WaitingItem {
  task_id: string;
  title: string;
  state: TaskRow["state"];
  review_state: TaskRow["review_state"];
  waiting_on: TaskRow["waiting_on"];
  reason: WaitingReason;
  row_page_id: string;
  agent_name: string | null;
  last_activity_at: string | null;
  approval: WaitingApproval | null;
  url: string;
}

export interface WaitingListData {
  kind: "waiting";
  items: WaitingItem[];
  app_url: string;
}

export type CardData = TaskCardData | WaitingListData;

// Shape of a tool result as the host forwards it (CallToolResult).
export interface ToolResultLike {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolFailure {
  code: string;
  message: string;
  detail: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// The card data inside a tool result, or null when the result carries something else.
export function cardDataFrom(value: unknown): CardData | null {
  if (!isObject(value)) return null;
  if (value.kind === "task" && isObject(value.task) && typeof value.task.id === "string") return value as unknown as TaskCardData;
  if (value.kind === "waiting" && Array.isArray(value.items)) return value as unknown as WaitingListData;
  return null;
}

// The error of a failed tool result ({code, message, detail} in structuredContent, text as fallback).
export function toolFailure(result: ToolResultLike | null | undefined): ToolFailure | null {
  if (!result?.isError) return null;
  const s = result.structuredContent;
  if (isObject(s) && typeof s.message === "string") {
    return { code: typeof s.code === "string" ? s.code : "error", message: s.message, detail: s.detail ?? null };
  }
  const text = result.content?.find((c) => c.type === "text" && c.text)?.text ?? "The tool call failed.";
  return { code: "error", message: text.split("\n")[0], detail: null };
}

// `task_id` of the tool input the host sent, when it has one.
export function taskIdFrom(args: unknown): string | null {
  return isObject(args) && typeof args.task_id === "string" && args.task_id ? args.task_id : null;
}

export function taskLink(appUrl: string, pageId: string, taskId: string): string {
  return `${appUrl.replace(/\/+$/, "")}${taskUrl(pageId, taskId)}`;
}

export function pageLink(appUrl: string, pageId: string): string {
  return `${appUrl.replace(/\/+$/, "")}${pageUrl(pageId)}`;
}

export const WAITING_REASON_LABEL: Record<WaitingReason, string> = {
  approval: "Needs your approval",
  input: "Has a question for you",
  review: "Ready for your review",
};
