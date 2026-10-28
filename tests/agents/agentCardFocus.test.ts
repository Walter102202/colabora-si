// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "@/components/agents/panel/ApprovalCard";
import { DecisionCard } from "@/components/agents/panel/DecisionCard";
import { TaskView } from "@/components/agents/panel";
import { cardDataFrom, type TaskCardData } from "@/lib/agentCard";
import { mockCard } from "@/components/agents/card/mock";
import type { ApprovalRow } from "@/lib/agentTasks";

// A deep link that names an approval (#approval-<id>) lands on it: the card
// gets an id, scrolls into view, shows a ring briefly and takes keyboard focus.
const base: ApprovalRow = {
  id: "ap-1", task_id: "t1", run_id: "r1", kind: "action", action: "send_email", params: { to: "x@example.com" },
  artifact_version: null, question: "Send it?", options: ["approve", "edit", "reject"], status: "pending",
  decision: null, response: null, decided_by: null, decided_at: null,
  expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: new Date().toISOString(),
};
const question: ApprovalRow = { ...base, id: "q-1", kind: "elicitation", action: null, params: {}, question: "Which tone?", options: ["respond", "ignore"] };
const onDecide = async () => {};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("ApprovalCard focus", () => {
  it("names itself, rings for two seconds and focuses the card itself (never Approve) when focused", () => {
    act(() => root.render(createElement(ApprovalCard, { approval: base, onDecide, focus: true })));
    const card = container.querySelector("#approval-ap-1");
    expect(card).not.toBeNull();
    expect(card!.className).toContain("ring-2");
    expect(document.activeElement).toBe(card);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(card!.className).not.toContain("ring-2");
  });

  it("drops the ring as soon as the focus moves away", () => {
    act(() => root.render(createElement(ApprovalCard, { approval: base, onDecide, focus: true })));
    act(() => root.render(createElement(ApprovalCard, { approval: base, onDecide, focus: false })));
    expect(container.querySelector("#approval-ap-1")!.className).not.toContain("ring-2");
  });

  it("does nothing without focus", () => {
    act(() => root.render(createElement(ApprovalCard, { approval: base, onDecide })));
    expect(container.querySelector("#approval-ap-1")).not.toBeNull();
    expect(container.querySelector("#approval-ap-1")!.className).not.toContain("ring-2");
    expect(document.activeElement).toBe(document.body);
  });
});

describe("DecisionCard focus", () => {
  it("focuses the card, not a choice, when there is no answer box", () => {
    const choicesOnly = { ...question, params: { choices: ["Formal", "Casual"] }, options: ["ignore"] as ApprovalRow["options"] };
    act(() => root.render(createElement(DecisionCard, { approval: choicesOnly, onDecide, focus: true })));
    const card = container.querySelector("#approval-q-1");
    expect(card!.className).toContain("ring-2");
    expect(document.activeElement).toBe(card);
  });

  it("focuses the answer box when the question is open", () => {
    act(() => root.render(createElement(DecisionCard, { approval: question, onDecide, focus: true })));
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
  });

  it("does nothing without focus", () => {
    act(() => root.render(createElement(DecisionCard, { approval: question, onDecide })));
    expect(container.querySelector("#approval-q-1")!.className).not.toContain("ring-2");
    expect(document.activeElement).toBe(document.body);
  });
});

describe("TaskView keeps approvals apart", () => {
  it("does not carry a half-typed answer from one approval to the next", () => {
    const data = cardDataFrom(mockCard("question")) as TaskCardData;
    const noop = async () => {};
    const view = (approval: ApprovalRow) => createElement(TaskView, {
      ...data, approval, subtasks: [], reviewerName: null, agent: null,
      onMessage: noop, onClose: noop, onDecide: noop, onReview: noop, onOpenTask: () => {}, onOpenPage: () => {},
    });
    expect(data.approval?.kind).not.toBe("action");
    act(() => root.render(view(data.approval!)));
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "Formal, please");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Formal, please");
    act(() => root.render(view({ ...data.approval!, id: "q-next", question: "Another question" })));
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });
});
