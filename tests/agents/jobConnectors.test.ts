// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Cell from "@/components/database/cells/Cell";
import { RowPanel } from "@/components/agents/RowPanel";
import { useAgentsStore, type AgentRow } from "@/lib/agentsStore";
import { useAgentTasks } from "@/lib/agentTasks";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import { db, prop, row } from "../clone/fixtures";
import type { DbOps } from "@/lib/dbOps";

const f = vi.hoisted(() => ({ assign: vi.fn(), connections: vi.fn(), spaces: vi.fn(), copy: vi.fn(), rpc: vi.fn() }));
const database = db([prop({ id: "title", name: "Name" }), prop({ id: "lead", name: "Lead", type: "person" }), prop({ id: "worker", name: "Worker", type: "agentDelegate" }), prop({ id: "status", name: "Status", type: "agentStatus" })], [row({ title: "Market research" }, "job")]);
const pages = { db: { title: "Launch plan", parentId: null, database }, job: { title: "Market research", parentId: "db", blocks: [] } };
vi.mock("@/lib/store", () => ({ useStore: (selector: (state: object) => unknown) => selector({ syncWorkspaceId: "w", pages }) }));
vi.mock("@/lib/agentActions", async (original) => ({ ...await original<typeof import("@/lib/agentActions")>(), assignJob: f.assign }));
vi.mock("@/lib/agentConnect", async (original) => ({ ...await original<typeof import("@/lib/agentConnect")>(), loadConnections: f.connections }));
vi.mock("@/lib/agentConsent", () => ({ connectWorkspaces: f.spaces }));
vi.mock("@/lib/agentClient", async (original) => ({ ...await original<typeof import("@/lib/agentClient")>(), getAgentClient: () => ({ rpc: f.rpc }) }));
const agents = [
  { id: "lead", name: "Claude Code", role: "lead", status: "enabled", revoked_at: null, is_platform: false },
  { id: "worker", name: "Codex", role: "worker", status: "enabled", revoked_at: null, is_platform: false },
] as AgentRow[];
const task = { ...(mockCard("1") as TaskCardData).task, id: "job-task", row_page_id: "job", db_page_id: "db", title: "Market research", delegate_agent_id: "lead", parent_task_id: null, state: "queued" as const, active_run_id: null, named_worker_ids: ["worker"], joined_worker_ids: [] };
const ops = { pageId: "db", database, readOnly: false } as DbOps;
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  f.assign.mockReset().mockResolvedValue({ task_id: task.id, granted_agents: [{ id: "lead", name: "Claude Code" }] });
  f.connections.mockReset().mockResolvedValue(agents.map((agent) => ({ agent_id: agent.id, verified_at: "2026-11-01" })));
  f.spaces.mockReset().mockResolvedValue([{ id: "w" }]); f.copy.mockReset().mockResolvedValue(undefined);
  f.rpc.mockReset().mockResolvedValue({ data: { task_id: task.id, granted_agents: [] }, error: null });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: f.copy } });
  useAgentsStore.setState({ agents, grants: [], workspaceId: "w", load: async () => {} });
  useAgentTasks.setState({ workspaceId: "w", tasks: {}, runs: {}, subscribe: () => () => {}, loadTask: async () => {}, loadTaskDetail: async () => {}, loadActivities: async () => {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const mountCell = (column: number) => act(async () => root.render(createElement(Cell, { ops, database, row: database.rows[0], property: database.properties[column], pages: pages as never })));
it("the Lead cell selects an eligible Lead through assign_job and reports database access", async () => {
  await mountCell(1);
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  expect(document.body.textContent).toContain("Lead for this job");
  const choose = [...document.querySelectorAll("[role='dialog'] button")].find((button) => button.textContent === "Claude Code") as HTMLButtonElement;
  await act(async () => choose.click());
  expect(f.assign).toHaveBeenCalledWith("job", "lead", []);
  expect(container.textContent).toContain("Claude Code now has access to Launch plan, so it can see every job here.");
});
it("a job worker selection preserves its Lead and sends the named crew", async () => {
  useAgentTasks.setState({ tasks: { [task.id]: { ...task, named_worker_ids: [] } } }); await mountCell(2);
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  const choose = [...document.querySelectorAll("[role='dialog'] button")].find((button) => button.textContent === "Codex") as HTMLButtonElement;
  await act(async () => choose.click());
  expect(f.assign).toHaveBeenCalledWith("job", "lead", ["worker"]);
});
it("a row writer without grant authority sees the owner request before assigning new access", async () => {
  f.spaces.mockResolvedValue([]); await mountCell(1);
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  expect(document.body.textContent).toContain("Ask the workspace owner to give Claude Code access.");
  expect(f.assign).not.toHaveBeenCalled();
});
it("the inline ready panel copies the real agent sentence without starting a task", async () => {
  useAgentTasks.setState({ tasks: { [task.id]: task } });
  await act(async () => root.render(createElement(MemoryRouter, {}, createElement(RowPanel, { pageId: "job", inline: true }))));
  expect(container.textContent).toContain("Ready when you are");
  await act(async () => (container.querySelector('[aria-label="Copy what to say to Claude Code"]') as HTMLButtonElement).click());
  expect(f.copy).toHaveBeenCalledWith("Work on Market research as Lead, with Codex as worker");
  expect(container.textContent).toContain("Waiting for Claude Code. This page updates when it arrives.");
  expect(f.assign).not.toHaveBeenCalled();
});
it("the assignment action uses the server RPC and preserves its access result", async () => {
  const actions = await vi.importActual<typeof import("@/lib/agentActions")>("@/lib/agentActions");
  await expect(actions.assignJob("job", "lead", ["worker"])).resolves.toEqual({ task_id: task.id, granted_agents: [] });
  expect(f.rpc).toHaveBeenCalledWith("assign_job", { p_row_page_id: "job", p_lead_agent_id: "lead", p_worker_agent_ids: ["worker"] });
});
it("a job's own page also chooses a Lead instead of bypassing job assignment", async () => {
  await act(async () => root.render(createElement(MemoryRouter, {}, createElement(RowPanel, { pageId: "job" }))));
  expect(container.textContent).toContain("Choose a Lead");
  expect(container.querySelector("select")).toBeNull();
});
