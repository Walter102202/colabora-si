import { describe, expect, it } from "vitest";
import { jobState, jobWait, subWait, type JobTask } from "@/lib/agentJobs";
import { waitsForAcceptance } from "@/lib/agentState";
import { deliverySummary } from "@/lib/agentTaskText";
import { waitingOnYou, type ActivityRow, type TaskRow } from "@/lib/agentTasks";
import { waitingOnYouCount, waitingOnYouRows } from "@/lib/databaseTaskValues";

const task = (id: string, patch: Partial<TaskRow>) => ({
  id, state: "working", review_state: "none", parent_task_id: null, request_kind: null, waiting_on: null,
  updated_at: "2026-11-01T10:00:00Z", last_activity_at: null, ...patch,
}) as TaskRow;
const delivered: JobTask = { state: "ready_for_review", review_state: "pending" };
const approved: JobTask = { state: "ready_for_review", review_state: "approved" };

describe("who a delivery waits on", () => {
  it("a delivered job waits on the person, whatever its workers did", () => {
    const job: JobTask = { state: "ready_for_review", named_worker_ids: ["muse"], joined_worker_ids: [] };
    expect(jobState(job, [approved, approved, delivered])).toBe("ready_for_review");
    expect(jobWait(job, [approved, approved, delivered])).toEqual({ label: "You", count: 1 });
  });
  it("a subtask the Lead approved and could not close waits on the person", () => {
    expect(subWait(approved)).toBe("You");
    expect(jobWait({ state: "working" }, [approved])).toEqual({ label: "You", count: 1 });
  });
  it("a delivery the Lead has not reviewed still waits on the Lead", () => {
    expect(subWait(delivered)).toBe("Lead");
    expect(jobWait({ state: "working" }, [delivered])).toEqual({ label: "Lead", count: 1 });
  });
});

describe("what a person accepts", () => {
  it("is a delivered job or an approved subtask, never a delivery in the Lead's hands or a system request", () => {
    expect(waitsForAcceptance(task("job", { state: "ready_for_review", review_state: "pending" }))).toBe(true);
    expect(waitsForAcceptance(task("sub", { state: "ready_for_review", review_state: "approved", parent_task_id: "job" }))).toBe(true);
    expect(waitsForAcceptance(task("sub", { state: "ready_for_review", review_state: "pending", parent_task_id: "job" }))).toBe(false);
    expect(waitsForAcceptance(task("job", { state: "working" }))).toBe(false);
    expect(waitsForAcceptance(task("lesson", { state: "ready_for_review", request_kind: "lesson" }))).toBe(false);
  });
  it("the inbox counts a job once, because one Accept settles its deliveries", () => {
    const tasks = {
      job: task("job", { state: "ready_for_review", review_state: "pending" }),
      sub: task("sub", { state: "ready_for_review", review_state: "approved", parent_task_id: "job" }),
      other: task("other", { state: "ready_for_review", review_state: "approved", parent_task_id: "open" }),
      open: task("open", { state: "working" }),
      asked: task("asked", { state: "input_required", waiting_on: "human" }),
    };
    expect(waitingOnYou({ tasks } as unknown as Parameters<typeof waitingOnYou>[0]).map((t) => t.id).sort()).toEqual(["asked", "job", "other"]);
  });
});

describe("the paragraph a person reads", () => {
  const activity = (body: Record<string, unknown>, type = "response") => ({ type, body }) as unknown as ActivityRow;
  it("is the latest delivery summary", () => {
    expect(deliverySummary([activity({ text: "First.", submit: true }), activity({ text: "Thinking" }), activity({ text: "Second.", submit: true })])).toBe("Second.");
  });
  it("stays short and never comes up empty", () => {
    expect(deliverySummary([activity({ text: "x".repeat(900), submit: true })]).length).toBeLessThanOrEqual(601);
    expect(deliverySummary([])).toBe("The work is delivered and ready for you to check.");
  });
});

describe("the Waiting on you view", () => {
  const rows = [
    { id: "job", cells: { status: "ready_for_review", wait: "You 1" } },
    { id: "sub", parentRowId: "job", cells: { status: "ready_for_review", wait: "You" } },
    { id: "busy", cells: { status: "working", wait: "Lead" } },
    { id: "ask", cells: { status: "waiting_workers", wait: "You 1" } },
    { id: "answer", parentRowId: "ask", cells: { status: "input_required", wait: "You" } },
  ];
  it("lists a delivered job with what it delivered", () => {
    expect(waitingOnYouRows(rows, "status", "wait").map((row) => row.id)).toEqual(["job", "sub", "answer"]);
  });
  it("counts a delivered job once, because one Accept settles it", () => {
    expect(waitingOnYouCount(rows, "status", "wait")).toBe(2);
  });
});
