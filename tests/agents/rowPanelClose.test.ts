// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskView, type TaskViewProps } from "@/components/agents/panel/RowPanelView";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import type { TaskState } from "@/lib/agentState";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const noop = async () => {};
const props = (state: TaskState, withDeliverable = true): TaskViewProps => {
  const data = mockCard("1") as TaskCardData;
  return { ...data, task: { ...data.task, state, active_run_id: null, waiting_on: state === "input_required" ? "human" : null },
    artifact: withDeliverable ? data.artifact : null, agent: null, review: null, subtasks: [], reviewerName: null,
    onMessage: noop, onClose: noop, onDecide: noop, onReview: noop, onOpenTask: () => {}, onOpenPage: () => {} };
};
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text);

describe("accept and close", () => {
  it.each(["artifact", "brief"])("drops prepared review findings and closure when the %s changes", (change) => {
    const original = props("ready_for_review");
    const next = change === "artifact" ? { ...original, artifact: { ...original.artifact!, id: "new-artifact", version: 2 } }
      : { ...original, task: { ...original.task, brief_version: original.task.brief_version + 1 } };
    act(() => root.render(createElement(TaskView, original)));
    act(() => button("Review it yourself")!.click());
    const select = container.querySelector('select[id*="-status-"]') as HTMLSelectElement;
    act(() => { select.value = "verified"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    act(() => button("Accept and close")!.click());
    expect(container.textContent).toContain("Accept the deliverable and close the task.");
    act(() => root.render(createElement(TaskView, next)));
    expect(container.textContent).not.toContain("Accept the deliverable and close the task.");
    expect(button("Review it yourself")).toBeDefined();
    act(() => button("Review it yourself")!.click());
    expect((container.querySelector('select[id*="-status-"]') as HTMLSelectElement).value).toBe("unverified");
  });
  it("a person accepts a deliverable that waits on them after a blocked or escalated review, as close_task allows", () => {
    act(() => root.render(createElement(TaskView, props("input_required"))));
    expect(button("Accept and close")!.disabled).toBe(false);
    act(() => button("Accept and close")!.click());
    expect(container.textContent).toContain("Accept the deliverable and close the task.");
  });
  it("without a deliverable only closing without accepting is offered", () => {
    act(() => root.render(createElement(TaskView, props("input_required", false))));
    expect(button("Accept and close")!.disabled).toBe(true);
    expect(button("Close without accepting")!.disabled).toBe(false);
  });
  it("a deliverable in review can still be accepted", () => {
    act(() => root.render(createElement(TaskView, props("ready_for_review"))));
    expect(button("Accept and close")!.disabled).toBe(false);
  });
});
