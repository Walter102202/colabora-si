import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import { databaseTaskValues } from "@/lib/databaseTaskValues";
import { db, prop, row } from "../clone/fixtures";
import { describe, expect, it } from "vitest";
import { pendingApprovalFor, taskForPage, type AgentTasksState, type ApprovalRow } from "@/lib/agentTasks";
import { openQuestionsFor } from "@/lib/agentCard";

// Which pending approval the row panel shows for a task.
const ap = (id: string, task_id: string, created_at: string, status: ApprovalRow["status"] = "pending"): ApprovalRow => ({
  id, task_id, run_id: null, kind: "action", action: "send_email", params: {}, artifact_version: null, question: "",
  options: ["approve", "reject"], status, decision: null, response: null, decided_by: null, decided_at: null,
  expires_at: "2026-11-01T00:00:00Z", created_at,
});
const state = {
  approvals: {
    late: ap("late", "t1", "2026-10-28T12:00:00Z"),
    early: ap("early", "t1", "2026-10-28T10:00:00Z"),
    other: ap("other", "t2", "2026-10-28T09:00:00Z"),
    done: ap("done", "t1", "2026-10-28T08:00:00Z", "decided"),
  },
} as unknown as AgentTasksState;

describe("pendingApprovalFor", () => {
  it("shows the oldest pending approval, like the chat card does", () => {
    expect(pendingApprovalFor(state, "t1")?.id).toBe("early");
  });
  it("shows the approval a deep link names when it is pending on this task", () => {
    expect(pendingApprovalFor(state, "t1", "late")?.id).toBe("late");
  });
  it("falls back to the oldest when the named approval is not pending here", () => {
    expect(pendingApprovalFor(state, "t1", "other")?.id).toBe("early");
    expect(pendingApprovalFor(state, "t1", "done")?.id).toBe("early");
    expect(pendingApprovalFor(state, "t1", "nope")?.id).toBe("early");
    expect(pendingApprovalFor(state, "t3", "late")).toBeNull();
  });
});

describe("questions that do not block", () => {
  const side = { ...ap("side", "t9", "2026-10-28T07:00:00Z"), kind: "elicitation", action: null, options: ["respond", "ignore"], blocking: false } as ApprovalRow;
  const gate = { ...ap("gate", "t9", "2026-10-28T11:00:00Z"), blocking: true } as ApprovalRow;
  const s = { approvals: { side, gate } } as unknown as AgentTasksState;
  it("never become the approval the panel and the row button act on", () => {
    expect(pendingApprovalFor(s, "t9")?.id).toBe("gate");
    expect(pendingApprovalFor(s, "t9", "side")?.id).toBe("gate");
  });
  it("are listed apart, oldest first, pending only", () => {
    const answered = { ...side, id: "answered", status: "decided" } as ApprovalRow;
    const later = { ...side, id: "later", created_at: "2026-10-28T13:00:00Z" } as ApprovalRow;
    expect(openQuestionsFor({ side, gate, answered, later }, "t9").map((q) => q.id)).toEqual(["side", "later"]);
    expect(openQuestionsFor({ side }, "t1")).toEqual([]);
  });
  it("after await_questions makes them all block, the ones behind the shown question stay listed as blocking", () => {
    const q1 = { ...side, id: "q1", blocking: true } as ApprovalRow;
    const q2 = { ...side, id: "q2", blocking: true, created_at: "2026-10-28T08:00:00Z" } as ApprovalRow;
    const q3 = { ...side, id: "q3", blocking: true, created_at: "2026-10-28T09:00:00Z" } as ApprovalRow;
    const s3 = { approvals: { q3, q1, q2, gate } } as unknown as AgentTasksState;
    const shown = pendingApprovalFor(s3, "t9");
    expect(shown?.id).toBe("q1");
    expect(openQuestionsFor(s3.approvals, "t9", shown!.id).map((q) => [q.id, q.blocking])).toEqual([["q2", true], ["q3", true]]);
    // A deep link to a later question shows it first; the older ones follow.
    expect(openQuestionsFor(s3.approvals, "t9", pendingApprovalFor(s3, "t9", "q3")!.id).map((q) => q.id)).toEqual(["q1", "q2"]);
  });
  it("reads the card's approvals_pending list the same way", () => {
    const q1 = { ...side, id: "q1", blocking: true } as ApprovalRow;
    const q2 = { ...side, id: "q2", blocking: true, created_at: "2026-10-28T08:00:00Z" } as ApprovalRow;
    expect(openQuestionsFor([q2, gate, q1], "t9", "q1").map((q) => q.id)).toEqual(["q2"]);
  });
});

describe("work tasks and AI requests on the same page", () => {
  const work = { ...(mockCard("1") as TaskCardData).task, id: "work", state: "done" as const, updated_at: "2026-10-30T10:00:00Z" };
  it.each(["working", "done"] as const)("ignores a newer %s rewrite when selecting the page's work", (status) => {
    const request = { ...work, id: "request", request_kind: "rewrite" as const, state: status, updated_at: "2026-10-30T11:00:00Z" };
    expect(taskForPage({ ...state, tasks: { work, request } }, work.row_page_id)?.id).toBe("work");
    expect(taskForPage({ ...state, tasks: { request } }, work.row_page_id)).toBeNull();
  });
  it("keeps work status and delegate in query-only database values", () => {
    const request = { ...work, id: "request", request_kind: "rewrite" as const, state: "working" as const, delegate_agent_id: "platform", updated_at: "2026-10-30T11:00:00Z" };
    const database = db([prop({ id: "s", type: "agentStatus" }), prop({ id: "a", type: "agentDelegate" })], [row({}, work.row_page_id)]);
    const result = databaseTaskValues(database, { work, request }, []);
    expect(result.rows[0].cells).toMatchObject({ s: "done", a: work.delegate_agent_id });
  });
});
