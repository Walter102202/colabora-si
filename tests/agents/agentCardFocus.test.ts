// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "@/components/agents/panel/ApprovalCard";
import { DecisionCard } from "@/components/agents/panel/DecisionCard";
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
  it("names itself, rings for two seconds and focuses Approve when focused", () => {
    act(() => root.render(createElement(ApprovalCard, { approval: base, onDecide, focus: true })));
    const card = container.querySelector("#approval-ap-1");
    expect(card).not.toBeNull();
    expect(card!.className).toContain("ring-2");
    expect((document.activeElement as HTMLElement).textContent).toBe("Approve");
    act(() => { vi.advanceTimersByTime(2000); });
    expect(card!.className).not.toContain("ring-2");
  });

  it("does nothing without focus", () => {
    act(() => root.render(createElement(ApprovalCard, { approval: base, onDecide })));
    expect(container.querySelector("#approval-ap-1")).not.toBeNull();
    expect(container.querySelector("#approval-ap-1")!.className).not.toContain("ring-2");
    expect(document.activeElement).toBe(document.body);
  });
});

describe("DecisionCard focus", () => {
  it("focuses the first choice when there are choices", () => {
    const withChoices = { ...question, params: { choices: ["Formal", "Casual"] } };
    act(() => root.render(createElement(DecisionCard, { approval: withChoices, onDecide, focus: true })));
    expect(container.querySelector("#approval-q-1")!.className).toContain("ring-2");
    expect((document.activeElement as HTMLElement).textContent).toBe("Formal");
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
