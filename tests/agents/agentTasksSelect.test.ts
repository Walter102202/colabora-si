import { describe, expect, it } from "vitest";
import { openQuestionsFor, pendingApprovalFor, type AgentTasksState, type ApprovalRow } from "@/lib/agentTasks";

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
});
