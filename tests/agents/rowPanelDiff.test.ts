// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowPanel } from "@/components/agents/RowPanel";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import type { DiffItem, TaskDiff } from "@/lib/agentRunDiff";
import { type ActivityRow, type ReviewRow, useAgentTasks } from "@/lib/agentTasks";
import { type AgentRow, useAgentsStore } from "@/lib/agentsStore";

const actions = vi.hoisted(() => ({ loadTaskDiff: vi.fn(), revertRun: vi.fn(), fetchTaskMetrics: vi.fn() })); // vi.mock is hoisted above the imports
vi.mock("@/lib/agentActions", () => ({
  ...actions, briefFromRow: vi.fn(), closeTask: vi.fn(), createTask: vi.fn(), decideApproval: vi.fn(), handOver: vi.fn(), reviewTask: vi.fn(), sendMessage: vi.fn(),
  getTaskAutonomy: vi.fn().mockResolvedValue(null), subscribeWorkspaceAutonomy: () => () => {}, workspaceAutonomyVersion: () => 0,
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
  actions.fetchTaskMetrics.mockReset().mockResolvedValue({ tasks: 0, metrics: [] });
  useAgentTasks.setState({ status: "ready", tasks: { [task.id]: task }, runs: {}, activities: { [task.id]: [] },
    subscribe: () => () => {}, loadTask: async () => {}, loadTaskDetail: async () => {}, loadActivities: async () => {}, loadTaskConversation: async () => {} });
  useAgentsStore.setState({ agents: [], load: async () => {} });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
const boxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const mount = async () => {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: [`/p/${task.row_page_id}`] }, createElement(RowPanel, { pageId: task.row_page_id }))));
};

it("loads all task runs and connects names and live totals in newest-first order", async () => {
  actions.loadTaskDiff.mockResolvedValue(null);
  const loadTask = vi.fn(async () => {});
  const base = (mockCard("1") as TaskCardData).run!;
  const older = { ...base, id: "older", task_id: task.id, agent_id: "a", harness: "codex", model: "muse-spark-1.3", started_at: "2026-11-01T00:00:00Z", input_tokens: 10, output_tokens: 2, cost_usd: 0.1 };
  const newer = { ...older, id: "newer", model: "muse-wonder-1.0", started_at: "2026-11-02T00:00:00Z" };
  useAgentTasks.setState({ loadTask, runs: { older, newer, other: { ...older, id: "other", task_id: "other-task", model: "hidden-model" } } });
  useAgentsStore.setState({ agents: [{ id: "a", name: "Worker" } as AgentRow] });
  await mount();
  expect(loadTask).toHaveBeenCalledWith(task.id);
  const card = container.querySelector('[aria-label="Runs & cost"]')!;
  const rows = card.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Muse Wonder 1.0");
  expect(rows[0].textContent).toContain("Worker");
  expect(card.textContent).not.toContain("hidden-model");
  await act(async () => useAgentTasks.setState({ runs: { older, newer: { ...newer, input_tokens: 30 } } }));
  expect(card.querySelector('tfoot [title="40"]')).not.toBeNull();
});

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
  it("a revert that works reads the results again; one that fails does not", async () => {
    const reverted = { key: "reverted_after_accept", status: "measured", value: 1, unit: "tasks", sample: 1, reason: null };
    actions.loadTaskDiff.mockResolvedValue(diffOf([x, y]));
    actions.fetchTaskMetrics.mockResolvedValueOnce({ tasks: 1, metrics: [{ ...reverted, value: 0 }] }).mockResolvedValue({ tasks: 1, metrics: [reverted] });
    actions.revertRun.mockRejectedValueOnce(new Error("Some of these changes were edited after the run.")).mockResolvedValueOnce({ reverted: ["block:p:x"] });
    await mount();
    expect(container.querySelector('section[aria-label="Results"]')?.textContent).toContain("0 of 1");
    act(() => boxes()[0].click());
    act(() => button("Revert selected").click());
    await act(async () => button("Confirm").click());
    expect(actions.fetchTaskMetrics).toHaveBeenCalledTimes(1);
    // The failed revert keeps the selection and the confirmation open: the person confirms again.
    await act(async () => button("Confirm").click());
    expect(actions.fetchTaskMetrics).toHaveBeenCalledTimes(2);
    expect(container.querySelector('section[aria-label="Results"]')?.textContent).toContain("1 of 1");
  });
});

it("a task deep link still opens an AI request instead of the page's work task", async () => {
  const request = { ...task, id: "rewrite-request", request_kind: "rewrite" as const };
  useAgentTasks.setState({ tasks: { [task.id]: task, [request.id]: request }, activities: { [request.id]: [] } });
  actions.loadTaskDiff.mockResolvedValue(diffOf([]));
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: [`/p/${task.row_page_id}?task=${request.id}`] }, createElement(RowPanel, { pageId: task.row_page_id }))));
  expect(actions.loadTaskDiff).toHaveBeenCalledWith(request.id);
});

it("shows the live job conversation in time order with agent names and review findings", async () => {
  const child = { ...task, id: "worker-task", title: "Research", parent_task_id: task.id, delegate_agent_id: "worker" };
  const parent = { ...task, delegate_agent_id: "lead" };
  const activity = (id: string, taskId: string, authorId: string, text: string, minute: number, type: ActivityRow["type"] = "prompt"): ActivityRow => ({
    id, task_id: taskId, run_id: null, seq: minute, type, body: { text, signal: "feedback" }, ephemeral: false,
    author_type: "agent", author_id: authorId, created_at: `2026-11-03T10:0${minute}:00Z`,
  });
  const progress = activity("progress", child.id, "worker", "Sources checked", 2, "thought");
  const leadMessage = activity("feedback", child.id, "lead", "Check the dates", 1);
  const parentMessage = activity("parent", parent.id, "worker", "Research is ready", 3, "response");
  const review = { id: "review", task_id: child.id, reviewer_type: "agent", reviewer_id: "lead", verdict: "changes_requested", findings: [{ status: "not_found", note: "Add sources" }], created_at: "2026-11-03T10:04:00Z" } as ReviewRow;
  const loadConversation = vi.fn(async () => {});
  useAgentTasks.setState({ tasks: { [parent.id]: parent, [child.id]: child }, activities: { [parent.id]: [parentMessage], [child.id]: [progress, leadMessage] }, reviews: { review }, loadTaskConversation: loadConversation });
  useAgentsStore.setState({ agents: [{ id: "lead", name: "Claude Code", capabilities: {} }, { id: "worker", name: "Codex", capabilities: {} }] as AgentRow[] });
  actions.loadTaskDiff.mockResolvedValue(diffOf([]));
  await mount();
  expect(loadConversation).toHaveBeenCalledWith(parent.id);
  const conversation = container.querySelector('section[aria-label="Conversation"]')!;
  expect([...conversation.querySelectorAll("li")].map((line) => line.textContent)).toEqual([
    expect.stringContaining("Claude Code → Codex (Research): Check the dates"),
    expect.stringContaining("Codex → Claude Code (Research): Sources checked"),
    expect.stringContaining("Codex → Claude Code: Research is ready"),
    expect.stringContaining("Claude Code → Codex (Research): Changes requested: not found — Add sources"),
  ]);
  expect(conversation.querySelectorAll("time")).toHaveLength(4);
  act(() => button("Show timeline").click());
  const timeline = [...container.querySelectorAll("section")].find((section) => section.querySelector("h4")?.textContent === "Timeline")!;
  expect(timeline.textContent).toContain("Codex");
  expect(timeline.textContent).not.toContain("Agent");
  const next = activity("new", child.id, "worker", "Dates corrected", 5, "response");
  act(() => useAgentTasks.setState({ activities: { [parent.id]: [parentMessage], [child.id]: [progress, leadMessage, next] } }));
  expect(conversation.querySelectorAll("li")).toHaveLength(5);
  expect(conversation.lastElementChild?.textContent).toContain("Dates corrected");
  const personMessage = { ...activity("person", parent.id, "person", "Add Y", 6), author_type: "human" as const, body: { text: "Add Y", source: "trama" } };
  act(() => useAgentTasks.setState({ activities: { [parent.id]: [parentMessage, personMessage], [child.id]: [progress, leadMessage, next] } }));
  expect(conversation.lastElementChild?.textContent).toContain("You (via Trama) → Claude Code: Add Y");
});
