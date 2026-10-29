// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskView, type TaskViewProps } from "@/components/agents/panel/RowPanelView";
import { mockActions, mockCard } from "@/components/agents/card/mock";
import { Card } from "@/components/agents/card/Card";
import type { TaskCardData } from "@/lib/agentCard";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const noop = async () => {};
const props = (): TaskViewProps => {
  const data = mockCard("1") as TaskCardData;
  const agent = { id: "agent-claude", name: "Claude Code", role: "worker" as const, capabilities: { resume: true } };
  return { ...data, task: { ...data.task, state: "working" }, agent, review: null, subtasks: [], reviewerName: null,
    continuity: { resume: true, checkpoint: { seq: 12, created_at: new Date().toISOString(), harness: "claude_code", next_step: "Finish", handover: true } },
    handOverAgents: [agent, { ...agent, id: "agent-codex", name: "Codex" }], onHandOver: vi.fn(noop),
    onMessage: noop, onClose: noop, onDecide: noop, onReview: noop, onOpenTask: () => {}, onOpenPage: () => {} };
};
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("task handover", () => {
  it("the header shows the continuity line", () => {
    act(() => root.render(createElement(TaskView, props())));
    expect(container.querySelector("header")?.textContent).toContain("checkpoint #12");
    expect(container.querySelector("header")?.textContent).toContain("claude_code");
    const input = props();
    act(() => root.render(createElement(TaskView, { ...input, task: { ...input.task, state: "ready_for_review" } })));
    expect(button("Hand over…").disabled).toBe(true);
  });
  it("Hand over sends the chosen agent and the note", async () => {
    const input = props();
    act(() => root.render(createElement(TaskView, input)));
    act(() => button("Hand over…").click());
    const select = container.querySelector("select")!;
    const label = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes("Note for the next agent"))!;
    const note = container.querySelector(`#${CSS.escape(label.htmlFor)}`) as HTMLTextAreaElement;
    act(() => {
      select.value = "agent-codex"; select.dispatchEvent(new Event("change", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Finish it and send it");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Hand over").click());
    expect(input.onHandOver).toHaveBeenCalledExactlyOnceWith("agent-codex", "Finish it and send it");
  });
  it("without onHandOver (the MCP card) there is no hand over control but the continuity line stays", () => {
    act(() => root.render(createElement(Card, { initial: mockCard("handover"), actions: mockActions("handover") })));
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Hand over"))).toBe(false);
    expect([...container.querySelectorAll("header")].map((h) => h.textContent).join(" ")).toContain("checkpoint #12");
  });
});
