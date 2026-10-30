import { describe, expect, it } from "vitest";
import { canAcceptAndClose, canTransition, continuationPlan, nextState, whatWillHappen, type TaskState } from "@/lib/agentState";

const task = (state: TaskState, active_run_id: string | null = null) => ({ state, active_run_id, brief_version: 2 });

describe("task state machine", () => {
  it("allows the transitions of the state diagram", () => {
    expect(nextState(task("queued"), "claim")).toBe("working");
    expect(nextState(task("working"), "input_needed")).toBe("input_required");
    expect(nextState(task("input_required", "run-1"), "decide")).toBe("working");
    expect(nextState(task("input_required"), "decide")).toBe("queued");
    expect(nextState(task("working"), "submit")).toBe("ready_for_review");
    expect(nextState(task("ready_for_review", "run-1"), "changes_requested")).toBe("working");
    expect(nextState(task("ready_for_review"), "changes_requested")).toBe("queued");
    expect(nextState(task("ready_for_review"), "blocked")).toBe("input_required");
    expect(nextState(task("ready_for_review"), "close")).toBe("done");
    expect(nextState(task("working"), "run_error")).toBe("failed");
    expect(nextState(task("queued"), "revoked")).toBe("failed");
    expect(nextState(task("queued"), "stop")).toBe("cancelled");
    expect(nextState(task("working"), "stop_acked")).toBe("cancelled");
    expect(nextState(task("input_required"), "stop")).toBe("cancelled");
    expect(nextState(task("ready_for_review"), "stop")).toBe("cancelled");
    expect(nextState(task("done"), "continue")).toBe("queued");
    expect(nextState(task("failed"), "retry")).toBe("queued");
    expect(nextState(task("cancelled"), "reopen")).toBe("queued");
  });

  it("refuses the transitions the diagram does not draw", () => {
    expect(canTransition("done", "claim")).toBe(false);
    expect(nextState(task("done"), "claim")).toBeNull();
    expect(canTransition("queued", "submit")).toBe(false);
    expect(canTransition("queued", "close")).toBe(false);
    expect(canTransition("working", "close")).toBe(false);
    expect(canTransition("working", "stop")).toBe(false);
    expect(canTransition("failed", "continue")).toBe(false);
    expect(canTransition("cancelled", "retry")).toBe(false);
    expect(canTransition("queued", "working" as never)).toBe(false);
  });
});

describe("continuationPlan", () => {
  const dispatchable = { name: "Codex", capabilities: { continue: true } };
  it("messages an open task without a run", () => {
    expect(continuationPlan(task("input_required"), dispatchable).kind).toBe("message");
    expect(continuationPlan(task("ready_for_review"), dispatchable).kind).toBe("message");
  });
  it("reopens a terminal task", () => {
    for (const s of ["done", "failed", "cancelled"] as const) expect(continuationPlan(task(s), dispatchable).kind).toBe("reopen");
  });
  it("queues behind an active run", () => {
    expect(continuationPlan(task("working", "run-9"), dispatchable).kind).toBe("queued");
  });
});

describe("whatWillHappen", () => {
  it("explains Continue by declared capabilities", () => {
    expect(whatWillHappen(task("queued"), { name: "Codex", capabilities: { continue: true } }, "continue", { artifactVersion: 1 })).toBe(
      "Dispatches to Codex with brief v2 and deliverable v1. Acknowledged in seconds. If a run is active, it queues.",
    );
    expect(whatWillHappen(task("queued"), { name: "Claude", capabilities: { approval: true } }, "continue")).toBe(
      "Stays queued. Claude will see it in your next conversation with list_my_tasks.",
    );
    expect(whatWillHappen(task("queued"), { name: "ChatGPT", capabilities: { events: true } }, "continue")).toMatch(/^Sends it to the subscribed chat/);
    expect(whatWillHappen(task("queued"), { name: "X", capabilities: {} }, "continue")).toMatch(/did not declare capabilities/);
    expect(whatWillHappen(task("done"), { name: "Codex", capabilities: { continue: true } }, "continue")).toMatch(/^Reopens the task with a new run/);
  });
  it("explains Stop and Approve", () => {
    expect(whatWillHappen(task("working", "r"), null, "stop")).toBe("Sends stop and waits for the run to acknowledge. Nothing is reverted.");
    expect(whatWillHappen(task("input_required"), null, "approve", { action: "send_email", params: { to: "ana@example.com" }, artifactVersion: 2, expiresIn: "14 min" })).toBe(
      "Send an email to ana@example.com for deliverable v2. The email leaves the workspace and cannot be recalled. Expires in 14 min.",
    );
  });
});

describe("accept and close", () => {
  it("mirrors close_task: a deliverable in review, or one waiting on a person after a blocked or escalated review", () => {
    expect(canAcceptAndClose("ready_for_review", true)).toBe(true);
    expect(canAcceptAndClose("input_required", true)).toBe(true);
    expect(canAcceptAndClose("input_required", false)).toBe(false);
    for (const state of ["queued", "working", "done", "failed", "cancelled"] as TaskState[]) expect(canAcceptAndClose(state, true)).toBe(false);
  });
});
