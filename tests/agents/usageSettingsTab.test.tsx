// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageSettingsTab } from "@/components/agents/UsageSettingsTab";
import { useAgentsStore, type AgentRow } from "@/lib/agentsStore";
import { useAgentTasks, type RunRow } from "@/lib/agentTasks";

const mocks = vi.hoisted(() => ({ workspace: "w", client: null as unknown }));
vi.mock("@/lib/store", () => ({ useStore: (select: (s: { syncWorkspaceId: string }) => unknown) => select({ syncWorkspaceId: mocks.workspace }) }));
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => mocks.client,
  agentErrorMessage: (e: { message?: string }) => e.message ?? String(e) }));

let root: Root;
let container: HTMLDivElement;
const unsubscribe = vi.fn();
const subscribe = vi.fn(() => unsubscribe);
const loadAgents = vi.fn(async () => {});
const agent = { id: "a", name: "Trama", workspace_id: "w", status: "enabled", revoked_at: null,
  monthly_budget_usd: 10, connection: {}, is_platform: true } as AgentRow;
const run = { id: "r", agent_id: "a", task_id: "t", model: "muse-wonder-1.0", harness: "muse", status: "running",
  input_tokens: 100, output_tokens: 20, cost_usd: 1, cost_kind: "measured", started_at: "2026-11-03T12:00:00Z", ended_at: null } as RunRow;
type Response = { data: unknown[]; error: { message: string } | null };
let requests: { table: string; signal?: AbortSignal; from?: number; since?: string; resolve: (r: Response) => void }[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T18:00:00Z"));
  vi.clearAllMocks();
  mocks.workspace = "w";
  requests = [];
  mocks.client = { from(table: string) {
    const state: { signal?: AbortSignal; from?: number; since?: string } = {};
    return { select() { return this; }, eq() { return this; }, order() { return this; },
      gte(_column: string, since: string) { state.since = since; return this; },
      range(from: number) { state.from = from; return this; },
      abortSignal(signal: AbortSignal) { state.signal = signal; return this; },
      then(resolve: (r: Response) => void) { return new Promise<Response>((done) => requests.push({ table, ...state, resolve: done })).then(resolve); },
    };
  } };
  useAgentsStore.setState({ workspaceId: "w", status: "ready", agents: [agent], error: null, load: loadAgents });
  useAgentTasks.setState({ workspaceId: "w", runs: {}, subscribe });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
const render = () => act(async () => { root.render(createElement(UsageSettingsTab)); });
async function answer(table: string, data: unknown[], error: Response["error"] = null) {
  const index = requests.findIndex((r) => r.table === table);
  expect(index).toBeGreaterThanOrEqual(0);
  const [request] = requests.splice(index, 1);
  await act(async () => { request.resolve({ data, error }); });
}
const refresh = () => act(async () => { [...container.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!.click(); });
const changePeriod = () => act(async () => {
  const select = container.querySelector("select")!; select.value = "30d";
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
async function ready() {
  await render(); await answer("model_prices", [{ model: "muse-wonder-1.0", input_usd_per_mtok: "4", output_usd_per_mtok: "20" }]);
  await answer("agent_runs", [run]);
}

it("paginates into the real view, includes platform agents, loads prices once and overlays live rows by id", async () => {
  await render();
  expect(container.textContent).toContain("Loading usage");
  expect(subscribe).toHaveBeenCalledWith("w");
  await answer("model_prices", [{ model: "muse-wonder-1.0", input_usd_per_mtok: "4", output_usd_per_mtok: "20" }]);
  await answer("agent_runs", Array.from({ length: 1000 }, (_, i) => ({ ...run, id: String(i) })));
  expect(requests[0].from).toBe(1000);
  await answer("agent_runs", [{ ...run, id: "1000" }]);
  expect(container.textContent).toContain("Trama");
  expect(container.textContent).toContain("Muse Wonder 1.0");
  expect(container.textContent).toContain("$4 / $20 per M");
  expect(container.querySelector("tfoot")?.textContent).toContain("1001");
  await act(async () => useAgentTasks.setState({ runs: {
    "0": { ...run, id: "0", input_tokens: 200 },
    old: { ...run, id: "old", started_at: "2026-09-01T00:00:00Z" },
  } }));
  expect(container.querySelector('tfoot [title="100,200"]')).not.toBeNull();
  await refresh();
  expect(requests.map((r) => r.table)).toEqual(["agent_runs"]);
});

it("keeps the last good tables on error and refresh recovers", async () => {
  await ready(); await refresh(); await answer("agent_runs", [], { message: "Network failed" });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Network failed");
  expect(container.textContent).toContain("Muse Wonder 1.0");
  await refresh(); await answer("agent_runs", []);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("No runs in this period.");
});

it("changes the UTC period and ignores superseded answers and errors", async () => {
  await ready(); await refresh();
  const previous = requests.shift()!;
  await changePeriod();
  expect(previous.signal?.aborted).toBe(true);
  expect(requests[0].since).toBe("2026-10-04T18:00:00.000Z");
  await answer("agent_runs", [{ ...run, input_tokens: 333 }]);
  await act(async () => previous.resolve({ data: [], error: { message: "Stale error" } }));
  expect(container.querySelector('[title="333"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("aborts on unmount and releases the realtime subscription", async () => {
  await render(); const signal = requests.find((r) => r.table === "agent_runs")!.signal;
  await act(async () => root.render(null));
  expect(signal?.aborted).toBe(true); expect(unsubscribe).toHaveBeenCalledOnce();
});

it("loads an idle agents store and waits for a workspace", async () => {
  useAgentsStore.setState({ status: "idle", workspaceId: null, agents: [] });
  await render();
  expect(loadAgents).toHaveBeenCalledWith("w");
  expect(requests).toHaveLength(0);
  expect(container.textContent).toContain("Loading usage");
  await act(async () => useAgentsStore.setState({ status: "error", error: "Could not load agents" }));
  expect(loadAgents).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not load agents");
  await refresh();
  expect(loadAgents).toHaveBeenCalledTimes(2);
  await act(async () => useAgentsStore.setState({ status: "ready", workspaceId: "w", agents: [agent] }));
  expect(requests).toHaveLength(2);
});

it("discards prior workspace data and does not overlay another workspace's runs", async () => {
  await ready();
  mocks.workspace = "other";
  await act(async () => useAgentsStore.setState({ workspaceId: "other", agents: [{ ...agent, name: "Other workspace" }] }));
  expect(container.textContent).not.toContain("Trama");
  await act(async () => useAgentTasks.setState({ workspaceId: "w", runs: { r: run } }));
  await answer("model_prices", []); await answer("agent_runs", []);
  expect(container.textContent).toContain("No runs in this period.");
  expect(container.textContent).not.toContain("Muse Wonder");
});
