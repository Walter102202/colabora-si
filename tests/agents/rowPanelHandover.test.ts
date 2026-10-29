// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskView, type TaskViewProps } from "@/components/agents/panel/RowPanelView";
import { mockActions, mockCard } from "@/components/agents/card/mock";
import { Card } from "@/components/agents/card/Card";
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
const claude = { id: "agent-claude", name: "Claude Code", role: "worker" as const, capabilities: { resume: true } };
const props = (): TaskViewProps => {
  const data = mockCard("1") as TaskCardData;
  return { ...data, task: { ...data.task, state: "working" }, agent: claude, review: null, subtasks: [], reviewerName: null,
    continuity: { resume: true, checkpoint: { seq: 12, created_at: new Date().toISOString(), harness: "claude_code", next_step: "Finish", handover: true } },
    handOverAgents: [claude, { ...claude, id: "agent-codex", name: "Codex" }, { ...claude, id: "agent-cursor", name: "Cursor", capabilities: {} }],
    onHandOver: vi.fn(noop), onMessage: noop, onClose: noop, onDecide: noop, onReview: noop, onOpenTask: () => {}, onOpenPage: () => {} };
};
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text);
const field = <T extends HTMLElement>(labelText: string) => {
  const label = [...container.querySelectorAll("label")].find((l) => l.textContent === labelText)!;
  return container.querySelector(`#${CSS.escape(label.htmlFor)}`) as T;
};
const choose = (select: HTMLSelectElement, value: string) => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); };
const type = (note: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, value);
  note.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("task handover", () => {
  it("the header shows the continuity line; a task waiting for review says why it cannot be handed over", () => {
    act(() => root.render(createElement(TaskView, props())));
    expect(container.querySelector("header")?.textContent).toContain("checkpoint #12");
    expect(container.querySelector("header")?.textContent).toContain("claude_code");
    const input = props();
    act(() => root.render(createElement(TaskView, { ...input, task: { ...input.task, state: "ready_for_review" } })));
    expect(button("Hand over…")!.disabled).toBe(true);
    expect(button("Hand over…")!.title).toBe("A task waiting for review cannot be handed over.");
  });
  it("Hand over sends the chosen agent and the note, then clears the form and returns the focus", async () => {
    const input = props();
    act(() => root.render(createElement(TaskView, input)));
    expect(button("Hand over…")!.getAttribute("aria-expanded")).toBe("false");
    act(() => button("Hand over…")!.click());
    expect(button("Hand over…")!.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      choose(field<HTMLSelectElement>("Hand over to"), "agent-codex");
      type(field<HTMLTextAreaElement>("Note for the next agent"), "Finish it and send it");
    });
    await act(async () => button("Hand over")!.click());
    expect(input.onHandOver).toHaveBeenCalledExactlyOnceWith("agent-codex", "Finish it and send it");
    expect(button("Hand over")).toBeUndefined();
    expect(document.activeElement).toBe(button("Hand over…"));
    act(() => button("Hand over…")!.click());
    expect(field<HTMLSelectElement>("Hand over to").value).toBe("");
    expect(field<HTMLTextAreaElement>("Note for the next agent").value).toBe("");
  });
  it("lists the other agents once, marks those that resume, and needs an agent when the task has none", async () => {
    act(() => root.render(createElement(TaskView, props())));
    act(() => button("Hand over…")!.click());
    const options = () => [...field<HTMLSelectElement>("Hand over to").options].map((o) => o.textContent);
    expect(options()).toEqual(["Same agent, new session", "Codex (resumes)", "Cursor"]);
    const input = { ...props(), agent: null, continuity: null };
    act(() => root.render(createElement(TaskView, input)));
    expect(options()).toEqual(["Claude Code (resumes)", "Codex (resumes)", "Cursor"]);
    await act(async () => button("Hand over")!.click());
    expect(input.onHandOver).toHaveBeenCalledExactlyOnceWith("agent-claude", "");
  });
  it("a failed handover shows its error next to the form", async () => {
    const input = { ...props(), onHandOver: vi.fn(async () => { throw new Error("That agent is not available in this workspace."); }) };
    act(() => root.render(createElement(TaskView, input)));
    act(() => button("Hand over…")!.click());
    await act(async () => button("Hand over")!.click());
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("That agent is not available in this workspace.");
    expect(alert?.closest("div")?.contains(field<HTMLSelectElement>("Hand over to"))).toBe(true);
    expect(button("Hand over")).toBeDefined();
  });
  it("a closed task offers no handover and shows no continuity line", () => {
    for (const state of ["done", "failed", "cancelled"] as TaskState[]) {
      const input = props();
      act(() => root.render(createElement(TaskView, { ...input, task: { ...input.task, state } })));
      expect([...container.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Hand over"))).toBe(false);
      expect(container.querySelector("header")?.textContent).not.toContain("checkpoint");
    }
  });
  it("without onHandOver (the MCP card) there is no hand over control but the continuity line stays", () => {
    act(() => root.render(createElement(Card, { initial: mockCard("handover"), actions: mockActions("handover") })));
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Hand over"))).toBe(false);
    expect([...container.querySelectorAll("header")].map((h) => h.textContent).join(" ")).toContain("checkpoint #12");
  });
});
