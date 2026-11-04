// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskView, type TaskViewProps } from "@/components/agents/panel/RowPanelView";
import { SubtaskList } from "@/components/agents/panel/SubtaskList";
import { mockCard } from "@/components/agents/card/mock";
import { buildProgressMilestones } from "@/lib/agentProgressActivity";
import type { TaskCardData } from "@/lib/agentCard";
import type { ActivityRow, ReviewRow, TaskRow } from "@/lib/agentTasks";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const noop = async () => {};
function props(): TaskViewProps {
  const data = mockCard("1") as TaskCardData;
  return {
    ...data, agent: { id: "a-worker", name: "Codex", role: "worker", capabilities: {} },
    reviewerName: "Claude Code", subtasks: [], currentUserId: "u1",
    onMessage: vi.fn(noop), onClose: vi.fn(noop), onDecide: vi.fn(noop), onReview: vi.fn(noop),
    onOpenTask: vi.fn(), onOpenPage: vi.fn(),
  };
}
const button = (text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === name)!;
const panel = (name: string) => container.querySelector<HTMLElement>(`[role="tabpanel"][aria-labelledby="${tab(name).id}"]`)!;
function type(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function activity(id: string, task: TaskRow, type: ActivityRow["type"], body: ActivityRow["body"], seq: number): ActivityRow {
  return { id, task_id: task.id, run_id: "run", seq, type, body, ephemeral: false, author_type: "agent", author_id: "a-worker", created_at: new Date(Date.UTC(2026, 10, 4, 10, seq)).toISOString() };
}

describe("task detail progress tabs", () => {
  it("starts with the deliverable and keeps the versioned review and all brief details reachable", () => {
    const input = props();
    input.review = { ...input.review!, verdict: "approved", outdated_by: "artifact" };
    input.brief = { ...input.brief!, constraints: "Keep every source row.", next_step: "An original next step", open_questions: ["Confirm the region"],
      decisions: [{ at: "2026-11-04T10:00:00Z", by: "u1", text: "Use UTC dates" }],
      sources: [{ kind: "url", ref: "javascript:alert(1)", trust: "external" }] };
    act(() => root.render(createElement(TaskView, input)));
    expect(tab("Work").getAttribute("aria-selected")).toBe("true");
    expect(panel("Work").hidden).toBe(false);
    expect(panel("Plan").hidden).toBe(true);
    expect(panel("Activity").hidden).toBe(true);
    expect(panel("Work").textContent).toContain("Leads cleanup summary");
    expect(panel("Work").textContent).toContain("by Claude Code · deliverable v2 · brief v2");
    expect(panel("Work").textContent).toContain("Review outdated:");
    act(() => tab("Plan").click());
    expect(panel("Plan").hidden).toBe(false);
    expect(panel("Plan").textContent).toContain("Keep every source row.");
    expect(panel("Plan").textContent).toContain("An original next step");
    expect(panel("Plan").textContent).toContain("Confirm the region");
    expect(panel("Plan").textContent).toContain("Use UTC dates");
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(input.onReview).not.toHaveBeenCalled();
    expect(input.onClose).not.toHaveBeenCalled();
  });

  it("keeps approval deep links and CI-gated acceptance available from every tab", async () => {
    const input = props();
    const approval = (mockCard("approval") as TaskCardData).approval!;
    input.approval = approval;
    input.focusApprovalId = approval.id;
    input.jobCi = { state: "pending", connected: true, sha: "a".repeat(40), checks: [{ check: "test", state: "pending", sources: [] }] };
    act(() => root.render(createElement(TaskView, input)));
    const action = container.querySelector<HTMLElement>(`#approval-${approval.id}`)!;
    expect(action).not.toBeNull();
    expect(action.closest("[hidden]")).toBeNull();
    expect(button("Accept").disabled).toBe(true);
    for (const name of ["Plan", "Activity", "Work"]) {
      act(() => tab(name).click());
      expect(action.closest("[hidden]")).toBeNull();
      expect(button("Accept").closest("[hidden]")).toBeNull();
      expect(button("Accept").disabled).toBe(true);
    }
    expect(input.onClose).not.toHaveBeenCalled();
    expect(input.onDecide).not.toHaveBeenCalled();
  });

  it("keeps feedback and unfinished reviewer findings through tab switches and incoming events", async () => {
    const input = props();
    act(() => root.render(createElement(TaskView, input)));
    const feedback = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Tell the agent what to change or what you decided…"]')!;
    act(() => type(feedback, "Keep the sources and fix the dates."));
    act(() => button("Take the review").click());
    const reviewNote = container.querySelector<HTMLInputElement>('input[id*="-note-c1"]')!;
    act(() => type(reviewNote, "Evidence checked against the source"));
    act(() => tab("Activity").click());
    act(() => root.render(createElement(TaskView, { ...input, activities: [...input.activities, activity("new", input.task, "thought", { text: "A new update" }, 12)] })));
    expect(tab("Activity").getAttribute("aria-selected")).toBe("true");
    act(() => tab("Plan").click());
    act(() => tab("Work").click());
    expect(feedback.isConnected).toBe(true);
    expect(reviewNote.isConnected).toBe(true);
    expect(feedback.value).toBe("Keep the sources and fix the dates.");
    expect(reviewNote.value).toBe("Evidence checked against the source");
    expect(input.onMessage).not.toHaveBeenCalled();
  });

  it("preserves single-task conversations and long reports, and only loads older activity on request", async () => {
    const input = props();
    const report = `${"Detailed evidence. ".repeat(55)}Do not lose this final qualification.`;
    input.activities = [activity("report", input.task, "response", { text: report, submit: true }, 3)];
    input.onLoadOlderActivity = vi.fn(noop);
    input.hasOlderActivity = true;
    act(() => root.render(createElement(TaskView, input)));
    expect(input.onLoadOlderActivity).not.toHaveBeenCalled();
    act(() => tab("Activity").click());
    expect(panel("Activity").textContent).toContain("Do not lose this final qualification.");
    expect(container.querySelector('[aria-label="Conversation"]')).not.toBeNull();
    await act(async () => button("Load older activity").click());
    expect(input.onLoadOlderActivity).toHaveBeenCalledTimes(1);
    act(() => root.render(createElement(TaskView, { ...input, activityLoading: true, activityError: "Could not load earlier events." })));
    expect(button("Loading earlier activity…").disabled).toBe(true);
    expect(panel("Activity").textContent).toContain(report);
    expect(panel("Activity").textContent).toContain("Could not load earlier events.");
  });

  it("provides keyboard tab navigation without submitting or losing typed feedback", () => {
    const input = props();
    act(() => root.render(createElement(TaskView, input)));
    act(() => {
      tab("Work").focus();
      tab("Work").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(tab("Plan"));
    expect(tab("Plan").getAttribute("aria-selected")).toBe("true");
    act(() => tab("Plan").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(tab("Activity"));
    expect(input.onMessage).not.toHaveBeenCalled();
  });

  it("offers recovery when the initial history load failed before a cursor was available", async () => {
    const input = { ...props(), onLoadOlderActivity: vi.fn(noop), hasOlderActivity: false, activityError: "Could not load task activity." };
    act(() => root.render(createElement(TaskView, input)));
    act(() => tab("Activity").click());
    await act(async () => button("Retry activity").click());
    expect(input.onLoadOlderActivity).toHaveBeenCalledTimes(1);
    expect(input.onMessage).not.toHaveBeenCalled();
  });

  it("distinguishes the current person from teammates in both messages and original activity", () => {
    const input = props();
    input.activities = [
      { ...activity("mine", input.task, "prompt", { text: "My feedback", signal: "feedback" }, 1), author_type: "human", author_id: "u1" },
      { ...activity("theirs", input.task, "prompt", { text: "Team feedback", signal: "feedback" }, 2), author_type: "human", author_id: "u2" },
    ];
    act(() => root.render(createElement(TaskView, input)));
    act(() => tab("Activity").click());
    const conversation = container.querySelector('[aria-label="Conversation"]');
    expect(conversation?.textContent).toContain("You → Codex: My feedback");
    expect(conversation?.textContent).toContain("A teammate → Codex: Team feedback");
    act(() => button("Show timeline").click());
    const timeline = container.querySelector('[id$="-timeline"]');
    expect(timeline?.textContent).toContain("You");
    expect(timeline?.textContent).toContain("A teammate");
  });

  it("explains acceptance without claiming publication, merging or deployment happened", () => {
    const input = props();
    input.task = { ...input.task, state: "done", acceptance: "accepted" };
    input.activities = [activity("delivered", input.task, "response", { text: "The source dates were verified.", submit: true }, 1)];
    act(() => root.render(createElement(TaskView, input)));
    const summary = [...panel("Work").querySelectorAll("p")].find((item) => item.textContent === "The source dates were verified.")!;
    expect(summary.closest("details")).toBeNull();
    expect(panel("Work").textContent).toContain("Acceptance records this delivery in the workspace.");
    expect(panel("Work").textContent).toContain("Check the linked source for publication or deployment status.");
    expect(container.textContent).not.toContain("Not deployed");
    expect(container.textContent).not.toContain("Not merged");
  });
});

it("counts failed and cancelled subtasks separately from accepted deliveries", () => {
  const base = props().task;
  const subtasks = [
    { ...base, id: "accepted", state: "done", acceptance: "accepted" },
    { ...base, id: "rejected", state: "done", acceptance: "rejected" },
    { ...base, id: "failed", state: "failed" },
    { ...base, id: "cancelled", state: "cancelled" },
    { ...base, id: "delivered", state: "ready_for_review" },
  ].map((task) => ({ task: task as TaskRow, run: null, agentName: "Codex" }));
  act(() => root.render(createElement(SubtaskList, { subtasks, onOpenTask: vi.fn() })));
  const summary = container.querySelector('[aria-label="Subtask progress"]')?.textContent;
  expect(summary).toContain("1 accepted");
  expect(summary).toContain("1 closed without accepting");
  expect(summary).toContain("1 failed");
  expect(summary).toContain("1 cancelled");
  expect(summary).toContain("1 in review");
  expect(summary).not.toContain("4 of 5");
});

describe("source-backed progress milestones", () => {
  it("separates meaningful events from raw operations and keeps versions and full evidence", () => {
    const input = props();
    const child = { ...input.task, id: "child", parent_task_id: input.task.id, row_page_id: "child-page", title: "Check sources" };
    const review = { ...input.review!, id: "review", task_id: child.id, verdict: "approved", outdated_by: "artifact" } as ReviewRow;
    const activities = [
      activity("heart", input.task, "action", { op: "heartbeat" }, 1),
      activity("row", input.task, "action", { op: "add_row", summary: "Added a row" }, 2),
      activity("delivered", child, "response", { text: "Sources are checked, including the caveat at the end.", submit: true }, 3),
      activity("review-echo", child, "prompt", { text: "Review feedback", signal: "feedback", review_id: review.id }, 4),
      activity("foreign", { ...child, id: "foreign" }, "response", { text: "Unrelated private task", submit: true }, 5),
      { ...activity("human", input.task, "prompt", { text: "Keep every source", signal: "feedback" }, 6), author_type: "human" as const, author_id: "someone-else" },
    ];
    const events = buildProgressMilestones({ task: input.task, subtasks: [child], activities, reviews: [review], agentNames: { "a-worker": "Codex", "a-lead": "Claude Code" }, userId: "u1" });
    expect(events.some((event) => ["activity:heart", "activity:row", "activity:review-echo", "activity:foreign"].includes(event.id))).toBe(false);
    expect(events.find((event) => event.id === "activity:delivered")?.detail).toContain("including the caveat at the end");
    const reviewed = events.find((event) => event.id === "review:review")!;
    expect(reviewed.taskId).toBe(child.id);
    expect(reviewed.detail).toContain("Deliverable v2 · brief v2");
    expect(reviewed.detail).toContain("Review outdated");
    expect(reviewed.author).toBe("Claude Code");
    expect(events.find((event) => event.id === "activity:human")?.author).toBe("A teammate");
    expect(activities).toHaveLength(6);
  });

  it("does not turn a stop request, external-action request or reviewer approval into completion", () => {
    const input = props();
    const events = buildProgressMilestones({ task: input.task, subtasks: [], reviews: [], agentNames: {}, activities: [
      activity("stop", input.task, "prompt", { signal: "stop", text: "" }, 1),
      activity("ask", input.task, "elicitation", { action: "merge_pr", question: "Merge PR #10?" }, 2),
    ] });
    expect(events.map((event) => event.label)).toEqual(["Stop requested", "Approval requested"]);
    expect(events.some((event) => /merged|deployed|completed|cancelled/i.test(event.label))).toBe(false);
  });
});
