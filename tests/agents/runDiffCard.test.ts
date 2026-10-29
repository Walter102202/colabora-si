// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDiffCard } from "@/components/agents/panel/RunDiffCard";
import { Card } from "@/components/agents/card/Card";
import { mockActions, mockCard } from "@/components/agents/card/mock";
import type { DiffItem, RunDiff, TaskDiff } from "@/lib/agentRunDiff";

const item: DiffItem = { key: "block:p:added", kind: "block", change: "added", page_id: "p", block_id: "added", status: "revertable",
  before_text: "", after_text: "Added text", after_rev: 1, current_rev: 1, summary: "Added paragraph", first_seq: 1, last_seq: 1 };
const edited: DiffItem = { ...item, key: "block:p:edited", block_id: "edited", change: "edited", before_text: "Hello A", after_text: "Hello from the agent", summary: "Edited paragraph" };
const changed: DiffItem = { ...item, key: "block:p:changed", block_id: "changed", change: "edited", status: "changed_since",
  before_text: "Original text", after_text: "Person changed this", summary: "Edited paragraph" };
const external: DiffItem = { ...item, key: "external:op1", block_id: undefined, before_text: null, after_text: null, kind: "external", change: "manual", status: "manual", summary: "Sent email" };
const run = (items: DiffItem[], status = "completed"): RunDiff => ({ run_id: "run-1", agent_id: "a", harness: "codex", status, started_at: "", ended_at: null, hidden_items: 0, items });
const taskDiff = (...runs: RunDiff[]): TaskDiff => ({ task_id: "t", hidden_items: 0, runs });
const diff = taskDiff(run([item, edited, changed, external]));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text);
const boxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const itemRow = (text: string) => [...container.querySelectorAll("li")].find((r) => r.textContent?.includes(text))!;

describe("run diff card", () => {
  it("lists each changed block with its text before and after and its status", () => {
    act(() => root.render(createElement(RunDiffCard, { diff })));
    for (const text of ["Hello A", "Hello from the agent", "Can be reverted", "Changed after the run: revert by hand", "Revert by hand"]) expect(container.textContent).toContain(text);
    expect(container.querySelector("del")?.textContent).toBe("A");
    expect(container.querySelector("ins")?.textContent).toBeTruthy();
    expect(itemRow("Hello from the agent").textContent).toContain("After: ");
    expect(itemRow("Person changed this").textContent).toContain("Now: ");
  });
  it("Revert selected asks for confirmation and sends only the revertable keys of that run", async () => {
    const onRevert = vi.fn(async () => {});
    act(() => root.render(createElement(RunDiffCard, { diff, onRevert })));
    expect(boxes()).toHaveLength(2);
    act(() => boxes()[0].click());
    act(() => button("Revert selected")!.click());
    expect(container.textContent).toContain("Revert 1 change?");
    act(() => button("Cancel")!.click());
    act(() => boxes()[1].click());
    act(() => button("Revert selected")!.click());
    expect(container.textContent).toContain("Revert 2 changes?");
    expect(onRevert).not.toHaveBeenCalled();
    await act(async () => button("Confirm")!.click());
    expect(onRevert).toHaveBeenCalledExactlyOnceWith("run-1", ["block:p:added", "block:p:edited"]);
    expect(document.activeElement?.textContent).toBe("Changes by codex");
  });
  it("a double click on Confirm sends one revert", async () => {
    const onRevert = vi.fn(async () => {});
    act(() => root.render(createElement(RunDiffCard, { diff, onRevert })));
    act(() => boxes()[0].click());
    act(() => button("Revert selected")!.click());
    await act(async () => { button("Confirm")!.click(); button("Confirm")!.click(); });
    expect(onRevert).toHaveBeenCalledTimes(1);
  });
  it("each checkbox is named by its own block, even within one write", () => {
    const appended = [{ ...item, key: "block:p:a1", block_id: "a1", after_text: "Alpha paragraph", summary: "Appended 2 block(s)" },
      { ...item, key: "block:p:a2", block_id: "a2", after_text: "Beta paragraph", summary: "Appended 2 block(s)" }];
    act(() => root.render(createElement(RunDiffCard, { diff: taskDiff(run(appended)), onRevert: async () => {} })));
    const names = boxes().map((box) => box.closest("label")?.textContent);
    expect(names).toEqual(['Added: "Alpha paragraph"', 'Added: "Beta paragraph"']);
  });
  it("without onRevert (the MCP card) there are no checkboxes and no revert button", () => {
    act(() => root.render(createElement(Card, { initial: mockCard("diff"), actions: mockActions("diff") })));
    expect(container.textContent).toContain("Hello from the agent");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Revert") || b.textContent === "Refresh")).toBe(false);
  });
  it("changed_since and gone items explain why they cannot be reverted and have no checkbox", () => {
    const gone: DiffItem = { ...item, key: "block:p:gone", block_id: "gone", status: "gone", after_text: null, summary: "Appended 3 block(s)" };
    act(() => root.render(createElement(RunDiffCard, { diff: taskDiff(run([changed, gone])), onRevert: async () => {} })));
    expect(itemRow("Person changed this").textContent).toContain("Changed after the run: revert by hand");
    expect(itemRow("Deleted after the run").textContent).toContain("Appended 3 block(s)");
    expect(boxes()).toHaveLength(0);
    expect(container.textContent).toContain("None of these changes can be reverted automatically.");
    expect(button("Revert selected")).toBeUndefined();
    act(() => root.render(createElement(RunDiffCard, { diff: { ...diff, hidden_items: 3, runs: [] } })));
    expect(container.textContent).toContain("3 change(s) on pages you cannot read");
  });
  it("a run that is still active offers no revert and says why", () => {
    for (const status of ["running", "waiting"]) {
      act(() => root.render(createElement(RunDiffCard, { diff: taskDiff(run([item, edited], status)), onRevert: async () => {} })));
      expect(boxes()).toHaveLength(0);
      expect(button("Revert selected")).toBeUndefined();
      expect(container.textContent).toContain("This run is still active; stop it to revert its changes.");
    }
  });
  it("a failed revert keeps its error and the reloaded diff drops the item that changed", async () => {
    const reloaded = taskDiff(run([{ ...item, status: "changed_since", after_text: "Added text, then edited" }, edited, changed, external]));
    const onRevert = vi.fn(async () => {
      // As the row panel does: the diff is reloaded before the error reaches the view.
      root.render(createElement(RunDiffCard, { diff: reloaded, onRevert }));
      throw new Error("Some of these changes were edited after the run.");
    });
    act(() => root.render(createElement(RunDiffCard, { diff, onRevert })));
    act(() => boxes().forEach((b) => b.click()));
    act(() => button("Revert selected")!.click());
    await act(async () => button("Confirm")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Some of these changes were edited after the run.");
    expect(itemRow("then edited").querySelector("input")).toBeNull();
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0].checked).toBe(true);
    expect(container.textContent).toContain("Revert 1 change?");
  });
  it("a failed revert that leaves nothing selected goes back to Revert selected instead of asking about zero changes", async () => {
    const reloaded = taskDiff(run([{ ...item, status: "changed_since" }, edited, changed, external]));
    const onRevert = vi.fn(async () => {
      root.render(createElement(RunDiffCard, { diff: reloaded, onRevert }));
      throw new Error("Some of these changes were edited after the run.");
    });
    act(() => root.render(createElement(RunDiffCard, { diff, onRevert })));
    act(() => itemRow("Added text").querySelector("input")!.click());
    act(() => button("Revert selected")!.click());
    await act(async () => button("Confirm")!.click());
    expect(container.textContent).not.toContain("Revert 0");
    expect(button("Confirm")).toBeUndefined();
    expect(button("Revert selected")?.disabled).toBe(true);
  });
  it("a Refresh that fails says so", async () => {
    const onRefresh = vi.fn(async () => { throw new Error("offline"); });
    act(() => root.render(createElement(RunDiffCard, { diff, onRevert: async () => {}, onRefresh })));
    await act(async () => button("Refresh")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not refresh the changes. Try again.");
  });
  it("Refresh asks for a fresh diff", async () => {
    const onRefresh = vi.fn(async () => {});
    act(() => root.render(createElement(RunDiffCard, { diff, onRevert: async () => {}, onRefresh })));
    await act(async () => button("Refresh")!.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
