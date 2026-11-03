// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskView, type TaskViewProps } from "@/components/agents/panel/RowPanelView";
import { sendMessage } from "@/lib/agentActions";
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
    act(() => button("Close without accepting")!.click());
    expect(container.textContent).toContain("Close the task without accepting the deliverable.");
    act(() => root.render(createElement(TaskView, next)));
    expect(container.textContent).not.toContain("Close the task without accepting the deliverable.");
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
  it("a delivery in the Lead's hands can still be accepted from the actions", () => {
    const base = props("ready_for_review");
    act(() => root.render(createElement(TaskView, { ...base, task: { ...base.task, parent_task_id: "job", review_state: "pending" } })));
    expect(button("Accept")).toBeUndefined();
    expect(button("Accept and close")!.disabled).toBe(false);
  });
});

describe("the Accept card", () => {
  const delivered = (accepted: string[], subtasks: TaskViewProps["subtasks"] = []): TaskViewProps => ({
    ...props("ready_for_review"), subtasks,
    onClose: async (acceptance, note) => { accepted.push(`${acceptance}:${note}`); },
    activities: [{ id: "a1", type: "response", body: { text: "Three areas researched and a list written.", submit: true } }] as unknown as TaskViewProps["activities"],
  });
  it("shows what was done and closes in one click, with one way to accept", async () => {
    const accepted: string[] = [];
    act(() => root.render(createElement(TaskView, delivered(accepted))));
    expect(container.textContent).toContain("Ready for you");
    expect(container.textContent).toContain("Three areas researched and a list written.");
    expect(button("Accept and close")).toBeUndefined();
    await act(async () => { button("Accept")!.click(); });
    expect(accepted).toEqual(["accepted:null"]);
  });
  it("says that the job's deliveries close with it", () => {
    const sub = delivered([]).task;
    const item = { task: { ...sub, id: "sub", parent_task_id: sub.id, state: "ready_for_review" as const }, run: null, agentName: "Muse Code" };
    act(() => root.render(createElement(TaskView, delivered([], [item, { ...item, task: { ...item.task, id: "sub2" } }]))));
    expect(container.textContent).toContain("Accepting also closes its 2 delivered subtasks.");
  });
  it("is gone once the work is closed", () => {
    act(() => root.render(createElement(TaskView, props("done"))));
    expect(container.textContent).not.toContain("Ready for you");
  });
});

it("delivered tasks offer review and feedback without an empty Continue", () => {
  act(() => root.render(createElement(TaskView, props("ready_for_review"))));
  expect(button("Continue")).toBeUndefined();
  expect(button("Close without accepting")).toBeDefined();
});

it.each(["done", "failed", "cancelled"] as const)("Reopen focuses feedback and only sending text restarts %s", async (state) => {
  const api = await import("@/lib/agentClient");
  const rpc = vi.fn(async () => ({ data: {}, error: null }));
  const spy = vi.spyOn(api, "getAgentClient").mockReturnValue({ rpc } as unknown as ReturnType<typeof api.getAgentClient>);
  const base = props(state);
  try {
    act(() => root.render(createElement(TaskView, { ...base, onMessage: async (text, signal) => { await sendMessage(base.task.id, text, signal); } })));
    act(() => button("Reopen")!.click());
    expect(rpc).not.toHaveBeenCalled();
    const input = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="What should change? Sending reopens the task."]')!;
    expect(document.activeElement).toBe(input);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Change the dates");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send")!.click());
    expect(rpc).toHaveBeenCalledWith("send_agent_message", expect.objectContaining({ p_task_id: base.task.id, p_body: "Change the dates", p_signal: "continue" }));
  } finally { spy.mockRestore(); }
});

it("explains message_required without restarting the task", async () => {
  const onMessage = vi.fn(async () => { throw new Error("message_required"); });
  act(() => root.render(createElement(TaskView, { ...props("working"), onMessage })));
  await act(async () => button("Continue")!.click());
  expect(container.textContent).toContain("Write what should change first.");
  expect(onMessage).toHaveBeenCalledExactlyOnceWith("", "continue");
  expect(button("Reopen")).toBeUndefined();
});

it("keeps written feedback when the server refuses it", async () => {
  const onMessage = vi.fn(async () => { throw new Error("message_required"); });
  act(() => root.render(createElement(TaskView, { ...props("done"), onMessage })));
  const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Change the dates");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Send")!.click());
  expect(container.textContent).toContain("Write what should change first.");
  expect(input.value).toBe("Change the dates");
  expect(button("Reopen")).toBeDefined();
});
