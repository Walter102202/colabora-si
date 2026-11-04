// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsSettingsTab } from "@/components/agents/AgentsSettingsTab";
import type { AgentRow } from "@/lib/agentsStore";

const agentFixture = {
  id: "a1", workspace_id: "w1", auth_user_id: "u1", name: "Trama", kind: "managed", delivery: "pull",
  role: "lead", autonomy: null, sponsor_user_id: "u1", status: "enabled", monthly_budget_usd: 20,
  capabilities: {}, connection: { harness: "managed" }, rate_limit_per_min: 10,
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", revoked_at: null, is_platform: true,
} as unknown as AgentRow;

const fakeRuns = [
  { id: "r1", agent_id: "a1", harness: "managed", model: "muse-wonder-1.0", status: "completed", input_tokens: 1000, output_tokens: 100, cost_usd: 0.5, cost_kind: "measured", started_at: "2026-11-02T00:00:00Z", ended_at: "2026-11-02T00:01:00Z" },
  { id: "r2", agent_id: "a1", harness: "managed", model: "muse-spark-1.3", status: "completed", input_tokens: 2000, output_tokens: 200, cost_usd: 0.25, cost_kind: "measured", started_at: "2026-11-03T00:00:00Z", ended_at: "2026-11-03T00:01:00Z" },
  { id: "r3", agent_id: "a2", harness: "codex", model: null, status: "completed", input_tokens: 5, output_tokens: 5, cost_usd: 0, cost_kind: "unknown", started_at: "2026-11-03T00:00:00Z", ended_at: null },
];

const store = vi.hoisted(() => ({ syncWorkspaceId: "w1" as string | null, pages: {} as Record<string, unknown> }));
const agentsState = vi.hoisted(() => ({
  status: "ready", error: null as string | null, workspaceId: "w1",
  agents: [] as unknown[], grants: [] as unknown[], tokens: [] as unknown[],
  load: async () => {}, createAgent: async () => ({ agentId: "a1", token: null }), enablePlatformAgent: async () => ({ agentId: "a1", token: null }),
  issueToken: async () => "tok", revokeToken: async () => {}, grantPage: async () => {},
  revokeGrant: async () => {}, setPaused: async () => {}, revokeAgent: async () => {},
}));
const captured = vi.hoisted(() => ({ detailProps: null as null | { usage?: unknown } }));

vi.mock("@/lib/store", () => ({ useStore: (select: (s: typeof store) => unknown) => select(store) }));
vi.mock("@/lib/agentsStore", () => ({
  useAgentsStore: (select?: (s: typeof agentsState) => unknown) => (select ? select(agentsState) : agentsState),
}));
vi.mock("@/lib/agentActions", () => ({ fetchAgentMetrics: async () => ({ metrics: [] }) }));
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => ({}) }));
vi.mock("@/lib/agentUsage", () => ({
  periodStart: () => "2026-11-01T00:00:00.000Z",
  loadUsageRuns: async () => fakeRuns,
}));
vi.mock("@/components/agents/settings/AutonomySettings", () => ({ AutonomySettings: () => createElement("fieldset", { "data-probe": "autonomy" }) }));
vi.mock("@/components/agents/settings/CiConnections", () => ({ CiConnections: () => createElement("section", { "data-probe": "ci" }) }));
vi.mock("@/components/agents/settings/LessonsList", () => ({ LessonsList: () => null }));
vi.mock("@/components/agents/settings/TelegramConnection", () => ({ TelegramConnection: () => null }));
vi.mock("@/components/agents/settings/AgentList", () => ({
  AgentList: ({ onOpen }: { onOpen: (id: string) => void }) => createElement("button", { type: "button", onClick: () => onOpen("a1") }, "Open agent"),
}));
vi.mock("@/components/agents/settings/ConnectedApps", () => ({ ConnectedApps: () => null }));
vi.mock("@/components/agents/settings/NewAgentWizard", () => ({ NewAgentWizard: () => null }));
vi.mock("@/components/agents/settings/AgentDetail", () => ({
  AgentDetail: (props: { usage?: unknown }) => {
    captured.detailProps = props;
    return createElement("div", { "data-probe": "detail" });
  },
}));
vi.mock("@/components/agents/settings/TokenReveal", () => ({ TokenReveal: () => null }));
vi.mock("@/components/agents/settings/EnvironmentList", () => ({ EnvironmentList: () => null }));
vi.mock("@/components/agents/settings/ConnectionSnippet", () => ({ ConnectionSnippet: () => null }));
vi.mock("@/components/agents/panel", () => ({ MetricsList: () => null }));

let roots: Root[] = [];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  store.syncWorkspaceId = "w1";
  agentsState.agents = [];
  captured.detailProps = null;
  roots = [];
  document.body.replaceChildren();
});
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  document.body.replaceChildren();
});

async function mountTab() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  const render = () => act(async () => root.render(createElement(AgentsSettingsTab)));
  await render();
  const count = (probe: string) => host.querySelectorAll(`[data-probe="${probe}"]`).length;
  return { host, render, count };
}

it("shows the autonomy block once however many times the tab renders", async () => {
  const tab = await mountTab();
  await tab.render();
  await tab.render();
  expect([tab.count("autonomy"), tab.count("ci")]).toEqual([1, 1]);
});

it("shows the autonomy block once after the workspace changes", async () => {
  const tab = await mountTab();
  store.syncWorkspaceId = "w2";
  await tab.render();
  expect([tab.count("autonomy"), tab.count("ci")]).toEqual([1, 1]);
});

it("feeds the agent detail a usage summary for this month from the container", async () => {
  agentsState.agents = [agentFixture];
  const tab = await mountTab();
  const open = [...tab.host.querySelectorAll("button")].find((b) => b.textContent === "Open agent")!;
  await act(async () => open.click());
  await act(async () => {});
  expect(captured.detailProps?.usage).toEqual({
    runs: 2, inputTokens: 3000, outputTokens: 300, costUsd: 0.75, lastModel: "muse-spark-1.3",
  });
});

it("renders the Usage this month block from props with a link to ?settings=usage", async () => {
  const { AgentDetail } = await vi.importActual<typeof import("@/components/agents/settings/AgentDetail")>("@/components/agents/settings/AgentDetail");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(AgentDetail, {
    agent: agentFixture,
    onBack: () => {},
    usage: { runs: 2, inputTokens: 3000, outputTokens: 300, costUsd: 0.75, lastModel: "muse-spark-1.3" },
  })));
  expect(host.textContent).toContain("Usage this month");
  expect(host.textContent).toContain("2 runs");
  expect(host.textContent).toContain("3k in");
  expect(host.textContent).toContain("$0.75");
  expect(host.textContent).toContain("Muse Spark 1.3");
  const link = [...host.querySelectorAll("a")].find((a) => a.textContent === "See all usage")!;
  expect(link.getAttribute("href")).toContain("?settings=usage");
});

it("hides the usage block when no usage prop is fed", async () => {
  const { AgentDetail } = await vi.importActual<typeof import("@/components/agents/settings/AgentDetail")>("@/components/agents/settings/AgentDetail");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(AgentDetail, { agent: agentFixture, onBack: () => {} })));
  expect(host.textContent).not.toContain("Usage this month");
});
