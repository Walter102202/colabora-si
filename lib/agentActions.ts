import type { ButtonAction } from "@/lib/types";
import { useStore } from "@/lib/store";
import { stripHtml } from "@/lib/utils";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";
import { pendingApprovalFor, taskForPage, useAgentTasks } from "@/lib/agentTasks";

// Control actions a person takes on a task. Every call is a SECURITY DEFINER
// RPC: the server decides, the client only asks.

export interface BriefInput {
  objective: string;
  constraints?: string;
  done_when?: { id: string; text: string; check: "human" | "deterministic" | "lead"; command?: string }[];
  decisions?: { at: string; by: string; text: string }[];
  sources?: { kind: "page" | "url" | "artifact"; ref: string; trust: "internal" | "external" }[];
  open_questions?: string[];
  next_step?: string;
  policies?: Record<string, unknown>;
}

// `messages` gives an error code a text specific to this action instead of the generic one.
async function rpc<T>(name: string, args: Record<string, unknown>, messages: Record<string, string> = {}): Promise<T> {
  const client = getAgentClient();
  if (!client) throw new Error("No connection. Agents need you to sign in.");
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(Object.hasOwn(messages, error.message) ? messages[error.message] : agentErrorMessage(error));
  return data as T;
}

// After an action: reload the one task it touched (row, runs, pending approvals,
// detail and newer activities); without a task id, the workspace's first page.
async function refresh(taskId: string | null = null) {
  const store = useAgentTasks.getState();
  if (!store.workspaceId) return;
  if (taskId) {
    await Promise.all([store.loadTask(taskId), store.loadTaskDetail(taskId), store.loadActivities(taskId)]);
  } else {
    await store.load(store.workspaceId);
  }
}

export async function createTask(
  rowPageId: string,
  brief: BriefInput,
  delegateAgentId: string | null = null,
  opts: { parentTaskId?: string | null; dependsOn?: string[]; idempotencyKey?: string | null } = {},
): Promise<{ task_id: string; context_id: string; brief_version: number }> {
  const res = await rpc<{ task_id: string; context_id: string; brief_version: number }>("create_agent_task", {
    p_row_page_id: rowPageId,
    p_brief: brief,
    p_delegate_agent_id: delegateAgentId,
    p_parent_task_id: opts.parentTaskId ?? null,
    p_reference_task_ids: [],
    p_depends_on_task_ids: opts.dependsOn ?? [],
    p_idempotency_key: opts.idempotencyKey ?? null,
  });
  await refresh(res.task_id);
  return res;
}

export type MessageSignal = "continue" | "feedback" | "stop";

export async function sendMessage(
  taskId: string,
  body: string,
  signal: MessageSignal = "feedback",
  blockIds: string[] = [],
  commentId: string | null = null,
): Promise<{ activity_id: string; delivery: string }> {
  const res = await rpc<{ activity_id: string; delivery: string }>("send_agent_message", {
    p_task_id: taskId,
    p_body: body,
    p_signal: signal,
    p_block_ids: blockIds,
    p_comment_id: commentId,
  });
  await refresh(taskId);
  return res;
}

export type ApprovalDecision = "approve" | "reject" | "edit" | "respond" | "ignore";

export async function decideApproval(
  approvalId: string,
  decision: ApprovalDecision,
  response: Record<string, unknown> | null = null,
): Promise<{ status: string; receipt?: string; receipt_expires_at?: string }> {
  const res = await rpc<{ status: string; receipt?: string; receipt_expires_at?: string }>("decide_approval", {
    p_approval_id: approvalId,
    p_decision: decision,
    p_response: response,
  });
  await refresh(useAgentTasks.getState().approvals[approvalId]?.task_id ?? null);
  return res;
}

export async function closeTask(taskId: string, acceptance: "accepted" | "rejected", note: string | null = null): Promise<void> {
  await rpc("close_task", { p_task_id: taskId, p_acceptance: acceptance, p_note: note });
  await refresh(taskId);
}

export async function reviewTask(
  taskId: string,
  verdict: "approved" | "changes_requested" | "blocked",
  findings: { criterion_id: string; status: "verified" | "not_found" | "contradicted" | "unverified"; note?: string; evidence_ref?: string }[],
  evidence: { kind: string; ref: string; hash?: string }[],
  artifactId: string | null,
): Promise<{ review_id: string; task_state: string; rounds: number }> {
  const res = await rpc<{ review_id: string; task_state: string; rounds: number }>("review_task", {
    p_task_id: taskId,
    p_verdict: verdict,
    p_findings: findings,
    p_evidence: evidence,
    p_artifact_id: artifactId,
  });
  await refresh(taskId);
  return res;
}

export async function handOver(taskId: string, toAgentId: string | null, note: string): Promise<{ task_state: string; delegate_agent_id: string | null }> {
  const result = await rpc<{ task_state: string; delegate_agent_id: string | null }>("release_for_handover", {
    p_task_id: taskId, p_to_agent_id: toAgentId, p_note: note || null,
  }, { invalid_state: "The task cannot be handed over in its current state." });
  await refresh(taskId);
  return result;
}

export async function updateBrief(
  taskId: string,
  patch: Partial<BriefInput> & { delegate_agent_id?: string | null; depends_on_task_ids?: string[] },
): Promise<number> {
  const version = await rpc<number>("update_brief", { p_task_id: taskId, p_patch: patch });
  await refresh(taskId);
  return version;
}

// Builds a first brief from what the person already wrote in the row page.
// The "Task brief" row template keeps the brief in keyed sections
// (brief:goal, brief:done_when, brief:constraints, brief:sources); a row
// without them falls back to the title and the "Done when" cell.
export function briefFromRow(pageId: string): BriefInput {
  const pages = useStore.getState().pages;
  const page = pages[pageId];
  if (!page) return { objective: "Untitled task" };

  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  for (const b of page.blocks) {
    if (b.key?.startsWith("brief:")) {
      current = b.key.slice("brief:".length);
      sections[current] ??= [];
      continue;
    }
    if (!current) continue;
    const text = stripHtml(b.html).trim();
    if (text) sections[current].push(text);
  }

  const parent = page.parentId ? pages[page.parentId] : undefined;
  const db = parent?.database;
  const row = db?.rows.find((r) => r.pageId === pageId);
  const doneProp = db?.properties.find((p) => p.name.toLowerCase() === "done when");
  const doneCell = doneProp && row && typeof row.cells[doneProp.id] === "string" ? (row.cells[doneProp.id] as string) : "";
  const criteria = sections.done_when?.length ? sections.done_when : doneCell.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);

  const sources: NonNullable<BriefInput["sources"]> = [{ kind: "page", ref: pageId, trust: "internal" }];
  for (const line of sections.sources ?? []) {
    for (const url of line.match(/https?:\/\/\S+/g) ?? []) sources.push({ kind: "url", ref: url, trust: "external" });
  }

  return {
    objective: sections.goal?.join("\n") || page.title.trim() || "Untitled task",
    constraints: (sections.constraints ?? []).join("\n").slice(0, 4000),
    done_when: criteria.map((text, i) => ({ id: `c${i + 1}`, text, check: "human" as const })),
    sources,
  };
}

// Executor of the `agentTask` button variant. The workspace button runner and
// the row button both delegate here.
export async function runAgentAction(action: ButtonAction, ctx: { pageId: string }): Promise<void> {
  if (action.kind !== "agentTask") return;
  const state = useAgentTasks.getState();
  const task = taskForPage(state, ctx.pageId);
  const open = task && !["done", "failed", "cancelled"].includes(task.state) ? task : null;
  switch (action.mode) {
    case "new":
    case "continue": {
      if (task && (open || action.mode === "continue")) {
        await sendMessage(task.id, action.message ?? "", "continue");
        return;
      }
      const brief = briefFromRow(ctx.pageId);
      if (action.message) brief.next_step = action.message;
      await createTask(ctx.pageId, brief, action.agentId ?? null);
      return;
    }
    case "stop": {
      if (!task) throw new Error("There is no task on this row.");
      await sendMessage(task.id, action.message ?? "", "stop");
      return;
    }
    case "approve": {
      if (!task) throw new Error("There is no task on this row.");
      const approval = pendingApprovalFor(state, task.id);
      if (!approval) throw new Error("Nothing is waiting for approval on this task.");
      await decideApproval(approval.id, "approve");
      return;
    }
  }
}
