import { describe, expect, it } from "vitest";
import { buildDecisionsHome, startOfLocalDay, type HomeInput } from "@/lib/agentHome";
import type { ApprovalRow, RunRow, TaskRow } from "@/lib/agentTasks";

// Run with TZ=UTC: the local day then starts at 2026-10-30T00:00:00Z.
const NOW = Date.parse("2026-10-30T15:00:00Z");
const ME = "u-me";

function task(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id, workspace_id: "w1", context_id: `ctx-${id}`, db_page_id: "db1", row_page_id: `row-${id}`, title: `Task ${id}`,
    delegate_agent_id: "ag-1", owner_user_id: ME, parent_task_id: null, depends_on_task_ids: [], state: "working",
    review_state: "none", acceptance: "pending", waiting_on: null, brief_version: 1, brief_stale: false, active_run_id: null,
    review_rounds: 0, max_review_rounds: 3, cost_usd: 0, last_activity_at: "2026-10-30T14:00:00Z",
    created_at: "2026-10-30T09:00:00Z", updated_at: "2026-10-30T14:00:00Z", closed_at: null, closed_by: null, ...over,
  };
}
function approval(id: string, taskId: string, over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id, task_id: taskId, run_id: "r1", kind: "action", action: "send_email", params: { to: "team@example.com" }, artifact_version: null,
    question: "Send it?", options: ["approve", "edit", "reject"], status: "pending", decision: null, response: null,
    decided_by: null, decided_at: null, expires_at: "2026-11-06T10:00:00Z", created_at: "2026-10-30T10:00:00Z", ...over,
  };
}
function run(id: string, taskId: string, over: Partial<RunRow> = {}): RunRow {
  return {
    id, task_id: taskId, agent_id: "ag-1", harness: "codex", brief_version: 1, status: "running", stop_requested_at: null,
    stop_acked_at: null, last_signal_at: "2026-10-30T14:59:00Z", stale_at: null, waiting_on_task_id: null, input_tokens: 0,
    output_tokens: 0, model: null, cost_usd: 0, cost_kind: "unknown", error_message: null, started_at: "2026-10-30T14:00:00Z", ended_at: null, ...over,
  };
}
const agents = [{ id: "ag-1", name: "Codex", role: "worker" }, { id: "lead-1", name: "Lead", role: "lead" }];
const home = (over: Partial<HomeInput>) => buildDecisionsHome({ tasks: [], approvals: [], runs: {}, agents, userId: ME, now: NOW, ...over });

describe("decisions home", () => {
  it("lists my pending decisions, blocking ones first and oldest first, with a deterministic text", () => {
    const h = home({
      tasks: [task("a", { state: "input_required" }), task("b"), task("c", { state: "input_required" })],
      approvals: [
        approval("ap-a", "a", { created_at: "2026-10-30T10:00:00Z" }),
        approval("q-b", "b", { kind: "elicitation", action: null, params: {}, question: "Which tone?", blocking: false, created_at: "2026-10-30T09:00:00Z" }),
        approval("ap-c", "c", { created_at: "2026-10-30T08:00:00Z" }),
      ],
    });
    expect(h.waiting.map((i) => i.key)).toEqual(["approval:ap-c", "approval:ap-a", "approval:q-b"]);
    expect(h.waiting[1]).toMatchObject({ detail: "Send an email to team@example.com", href: "/p/row-a?task=a#approval-ap-a", agentName: "Codex", nonBlocking: false });
    expect(h.waiting[2]).toMatchObject({ detail: "Which tone?", nonBlocking: true });
  });
  it("leaves out other people's tasks, closed tasks, decided approvals and approvals of tasks it cannot see", () => {
    const h = home({
      tasks: [task("d", { owner_user_id: "u-other", state: "input_required" }), task("e", { state: "done", closed_at: "2026-10-29T10:00:00Z" }), task("f", { state: "input_required" })],
      approvals: [approval("ap-d", "d"), approval("ap-e", "e"), approval("ap-f", "f", { status: "decided" }), approval("ap-x", "not-loaded")],
    });
    expect(h.waiting.map((i) => i.key)).toEqual(["task:f"]);
    expect(h.waiting[0]).toMatchObject({ detail: "Waiting for you", href: "/p/row-f?task=f" });
  });
  it("does not ask me for what waits on a Lead or another agent", () => {
    const h = home({ tasks: [task("g", { state: "input_required", waiting_on: "lead" }), task("g2", { state: "input_required", waiting_on: "agent" })] });
    expect(h.waiting).toEqual([]);
  });
  it("shows what agents are doing and flags a run without signals", () => {
    const h = home({
      tasks: [task("h", { active_run_id: "r-h", last_activity_at: "2026-10-30T14:30:00Z" }), task("i", { active_run_id: "r-i", last_activity_at: "2026-10-30T12:00:00Z" }), task("j", { last_activity_at: null })],
      runs: { "r-h": run("r-h", "h"), "r-i": run("r-i", "i", { stale_at: "2026-10-30T13:00:00Z" }) },
    });
    expect(h.working.map((i) => [i.taskId, i.detail, i.stale])).toEqual([["h", "Working", false], ["j", "Working", false], ["i", "No signals lately", true]]);
  });
  it("leaves to the Lead the subtasks it reviews", () => {
    const h = home({
      tasks: [
        task("p", { delegate_agent_id: "lead-1" }),
        task("k", { state: "ready_for_review", parent_task_id: "p" }),
        task("l", { state: "ready_for_review", updated_at: "2026-10-30T13:00:00Z" }),
        task("m", { state: "ready_for_review", review_state: "outdated", updated_at: "2026-10-30T12:00:00Z" }),
      ],
    });
    expect(h.review.map((i) => [i.taskId, i.detail])).toEqual([["l", "Deliverable ready"], ["m", "Review outdated"]]);
  });
  it("counts as done today what closed since local midnight; failed and stopped tasks have no closed_at", () => {
    expect(startOfLocalDay(NOW)).toBe(Date.parse("2026-10-30T00:00:00Z"));
    const h = home({
      tasks: [
        task("n", { state: "done", acceptance: "accepted", closed_at: "2026-10-30T00:00:00Z" }),
        task("o", { state: "failed", updated_at: "2026-10-30T11:00:00Z" }),
        task("q", { state: "cancelled", updated_at: "2026-10-30T12:00:00Z" }),
        task("r", { state: "done", acceptance: "accepted", closed_at: "2026-10-29T23:59:59Z" }),
        task("t", { state: "failed", updated_at: "2026-10-29T20:00:00Z" }),
      ],
    });
    expect(h.done.map((i) => [i.taskId, i.detail])).toEqual([["q", "Stopped"], ["o", "Failed"], ["n", "Accepted"]]);
  });
  it("is empty without a signed-in person", () => {
    expect(home({ userId: null, tasks: [task("s", { state: "input_required" })] })).toEqual({ waiting: [], working: [], review: [], done: [] });
  });
});
