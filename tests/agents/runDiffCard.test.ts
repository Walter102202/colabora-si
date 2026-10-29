// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDiffCard } from "@/components/agents/panel/RunDiffCard";
import { Card } from "@/components/agents/card/Card";
import { mockActions, mockCard } from "@/components/agents/card/mock";
import type { DiffItem, TaskDiff } from "@/lib/agentRunDiff";

const item: DiffItem = { key: "block:p:added", kind: "block", change: "added", page_id: "p", block_id: "added", status: "revertable",
  before_text: "", after_text: "Added text", after_rev: 1, current_rev: 1, summary: "Added paragraph", first_seq: 1, last_seq: 1 };
const diff: TaskDiff = { task_id: "t", hidden_items: 0, runs: [{ run_id: "run-1", agent_id: "a", harness: "codex", status: "completed", started_at: "", ended_at: null, hidden_items: 0,
  items: [item, { ...item, key: "block:p:edited", block_id: "edited", change: "edited", before_text: "Hello A", after_text: "Hello from the agent", summary: "Edited paragraph" },
    { ...item, key: "block:p:changed", block_id: "changed", status: "changed_since", summary: "Person changed this" },
    { ...item, key: "external:op1", block_id: undefined, before_text: null, after_text: null, kind: "external", change: "manual", status: "manual", summary: "Sent email" }] }] };
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("run diff card", () => {
  it("lists each changed block with its text before and after and its status", () => {
    act(() => root.render(createElement(RunDiffCard, { diff })));
    for (const text of ["Hello A", "Hello from the agent", "Can be reverted", "Changed after the run: revert by hand", "Revert by hand"]) expect(container.textContent).toContain(text);
    expect(container.querySelector("del")?.textContent).toBe("A");
    expect(container.querySelector("ins")?.textContent).toBeTruthy();
  });
  it("Revert selected asks for confirmation and sends only the revertable keys of that run", async () => {
    const onRevert = vi.fn(async () => {});
    act(() => root.render(createElement(RunDiffCard, { diff, onRevert })));
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    act(() => boxes.forEach((b) => b.click()));
    act(() => button("Revert selected").click());
    expect(container.textContent).toContain("Revert 2 changes?");
    expect(onRevert).not.toHaveBeenCalled();
    await act(async () => button("Confirm").click());
    expect(onRevert).toHaveBeenCalledExactlyOnceWith("run-1", ["block:p:added", "block:p:edited"]);
  });
  it("without onRevert (the MCP card) there are no checkboxes and no revert button", () => {
    act(() => root.render(createElement(Card, { initial: mockCard("diff"), actions: mockActions("diff") })));
    expect(container.textContent).toContain("Hello from the agent");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Revert"))).toBe(false);
  });
  it("a changed_since item explains why it cannot be reverted", () => {
    act(() => root.render(createElement(RunDiffCard, { diff, onRevert: async () => {} })));
    const row = [...container.querySelectorAll("li")].find((r) => r.textContent?.includes("Person changed this"))!;
    expect(row.textContent).toContain("Changed after the run: revert by hand");
    expect(row.querySelector("input")).toBeNull();
    act(() => root.render(createElement(RunDiffCard, { diff: { ...diff, hidden_items: 3, runs: [] } })));
    expect(container.textContent).toContain("3 change(s) on pages you cannot read");
  });
});
