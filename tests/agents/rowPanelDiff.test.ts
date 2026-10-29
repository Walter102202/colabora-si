// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowPanel } from "@/components/agents/RowPanel";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import type { DiffItem, TaskDiff } from "@/lib/agentRunDiff";
import { useAgentTasks } from "@/lib/agentTasks";
import { useAgentsStore } from "@/lib/agentsStore";

const actions = vi.hoisted(() => ({ loadTaskDiff: vi.fn(), revertRun: vi.fn() })); // vi.mock is hoisted above the imports
vi.mock("@/lib/agentActions", () => ({
  ...actions, briefFromRow: vi.fn(), closeTask: vi.fn(), createTask: vi.fn(), decideApproval: vi.fn(), handOver: vi.fn(), reviewTask: vi.fn(), sendMessage: vi.fn(),
}));
vi.mock("@/lib/store", () => ({ useStore: (sel: (s: { syncWorkspaceId: string }) => unknown) => sel({ syncWorkspaceId: "w1" }) }));

const task = (mockCard("1") as TaskCardData).task;
const x: DiffItem = { key: "block:p:x", kind: "block", change: "added", page_id: "p", block_id: "x", status: "revertable",
  before_text: "", after_text: "Paragraph X", after_rev: 1, current_rev: 1, summary: "Appended 2 block(s)", first_seq: 1, last_seq: 1 };
const y: DiffItem = { ...x, key: "block:p:y", block_id: "y", after_text: "Paragraph Y" };
const diffOf = (items: DiffItem[]): TaskDiff => ({ task_id: task.id, hidden_items: 0, runs: [{ run_id: "run-1", agent_id: "a", harness: "codex",
  status: "completed", started_at: "", ended_at: null, hidden_items: 0, items }] });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  actions.loadTaskDiff.mockReset(); actions.revertRun.mockReset();
  useAgentTasks.setState({ status: "ready", tasks: { [task.id]: task }, activities: { [task.id]: [] },
    subscribe: () => () => {}, loadTaskDetail: async () => {}, loadActivities: async () => {} });
  useAgentsStore.setState({ agents: [], load: async () => {} });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
const boxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const mount = async () => {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: [`/p/${task.row_page_id}`] }, createElement(RowPanel, { pageId: task.row_page_id }))));
};

describe("row panel diff", () => {
  it("a revert that fails reloads the diff, so the block a person edited loses its checkbox", async () => {
    actions.loadTaskDiff.mockResolvedValueOnce(diffOf([x, y])).mockResolvedValueOnce(diffOf([{ ...x, status: "changed_since", after_text: "Paragraph X, edited" }, y]));
    actions.revertRun.mockRejectedValueOnce(new Error("Some of these changes were edited after the run."));
    await mount();
    expect(boxes()).toHaveLength(2);
    act(() => boxes().forEach((b) => b.click()));
    act(() => button("Revert selected").click());
    await act(async () => button("Confirm").click());
    expect(actions.revertRun).toHaveBeenCalledExactlyOnceWith(task.id, "run-1", ["block:p:x", "block:p:y"]);
    expect(actions.loadTaskDiff).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Some of these changes were edited after the run.");
    expect(container.textContent).toContain("Paragraph X, edited");
    expect(boxes().map((b) => b.closest("label")?.textContent)).toEqual(['Added: "Paragraph Y"']);
  });
  it("a Refresh that fails keeps the diff on screen and says so", async () => {
    actions.loadTaskDiff.mockResolvedValueOnce(diffOf([x, y])).mockRejectedValueOnce(new Error("offline"));
    await mount();
    await act(async () => button("Refresh").click());
    expect(actions.loadTaskDiff).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Paragraph X");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not refresh the changes. Try again.");
  });
  it("a revert that works and the Refresh button both load the diff again", async () => {
    actions.loadTaskDiff.mockResolvedValue(diffOf([x, y]));
    actions.revertRun.mockResolvedValueOnce({ reverted: ["block:p:x"] });
    await mount();
    act(() => boxes()[0].click());
    act(() => button("Revert selected").click());
    await act(async () => button("Confirm").click());
    expect(actions.loadTaskDiff).toHaveBeenCalledTimes(2);
    await act(async () => button("Refresh").click());
    expect(actions.loadTaskDiff).toHaveBeenCalledTimes(3);
  });
});
