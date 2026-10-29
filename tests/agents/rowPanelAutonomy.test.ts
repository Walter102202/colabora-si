// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowPanel } from "@/components/agents/RowPanel";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import type { TaskAutonomy } from "@/lib/agentAutonomy";
import { setWorkspaceAutonomy } from "@/lib/agentActions";
import { useAgentTasks } from "@/lib/agentTasks";
import { useAgentsStore } from "@/lib/agentsStore";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() })); // vi.mock is hoisted above the imports
vi.mock("@/lib/agentClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentClient")>()),
  getAgentClient: () => ({ rpc }),
}));
vi.mock("@/lib/store", () => ({ useStore: (sel: (s: { syncWorkspaceId: string }) => unknown) => sel({ syncWorkspaceId: "w1" }) }));

const task = { ...(mockCard("1") as TaskCardData).task, state: "working" as const };
const balanced: TaskAutonomy = { level: "balanced", requested: null, source: "workspace", workspace_level: "balanced", auto_approved: ["publish_page"], require_approval: [], can_edit: true };
const autonomous: TaskAutonomy = { ...balanced, level: "autonomous", requested: "autonomous", source: "task", auto_approved: ["publish_page", "send_email"] };

// Every task_autonomy read waits until the test answers it, so the test decides the order.
let reads: { taskId: unknown; answer: (value: TaskAutonomy) => void }[];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  reads = [];
  rpc.mockReset().mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === "task_autonomy") return new Promise((resolve) => reads.push({ taskId: args.p_task_id, answer: (data) => resolve({ data, error: null }) }));
    if (name === "set_task_autonomy") return Promise.resolve({ data: autonomous, error: null });
    if (name === "set_workspace_autonomy") return Promise.resolve({ data: { level: args.p_level, previous: "balanced" }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
  useAgentTasks.setState({ status: "ready", tasks: { [task.id]: task }, activities: { [task.id]: [] },
    subscribe: () => () => {}, loadTaskDetail: async () => {}, loadActivities: async () => {} });
  useAgentsStore.setState({ agents: [], load: async () => {} });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const mount = async () => {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: [`/p/${task.row_page_id}`] }, createElement(RowPanel, { pageId: task.row_page_id }))));
};
const answer = (i: number, value: TaskAutonomy) => act(async () => reads[i].answer(value));
const choose = (value: string) => act(async () => {
  const select = container.querySelector('select[aria-label="Autonomy for this task"]') as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
});

describe("autonomy in the row panel", () => {
  it("reads the line again after the workspace level changes from this browser", async () => {
    await mount();
    await answer(0, balanced);
    expect(container.textContent).toContain("Autonomy: Balanced (workspace default)");
    await act(async () => { await setWorkspaceAutonomy("w1", "ask"); });
    expect(reads).toHaveLength(2);
    await answer(1, { ...autonomous, level: "ask", source: "workspace", workspace_level: "ask", auto_approved: [] });
    expect(container.textContent).toContain("Autonomy: Ask first (limited by the workspace)");
  });

  it("a read that started before a change returned does not overwrite the change", async () => {
    await mount();
    await answer(0, balanced);
    act(() => useAgentTasks.setState({ tasks: { [task.id]: { ...task, brief_version: task.brief_version + 1 } } }));
    expect(reads).toHaveLength(2);
    await choose("autonomous");
    expect(container.textContent).toContain("Autonomy: Autonomous (set on this task)");
    await answer(1, balanced);
    expect(container.textContent).toContain("Autonomy: Autonomous (set on this task)");
    expect(container.textContent).not.toContain("workspace default)");
  });

  it("never shows the autonomy read for another task", async () => {
    await mount();
    await answer(0, autonomous);
    expect(container.textContent).toContain("Autonomy: Autonomous (set on this task)");
    const other = { ...task, id: "t-other", title: "Another task on this row" };
    act(() => useAgentTasks.setState({ tasks: { [other.id]: other }, activities: { [other.id]: [] } }));
    expect(reads.map((r) => r.taskId)).toEqual([task.id, other.id]);
    expect(container.textContent).not.toContain("Autonomy:");
    await answer(1, balanced);
    expect(container.textContent).toContain("Autonomy: Balanced (workspace default)");
  });
});
