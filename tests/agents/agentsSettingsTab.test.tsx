// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentsSettingsTab } from "@/components/agents/AgentsSettingsTab";

const store = vi.hoisted(() => ({ syncWorkspaceId: "w1" as string | null }));

vi.mock("@/lib/store", () => ({ useStore: (select: (s: typeof store) => unknown) => select(store) }));
vi.mock("@/lib/agentsStore", () => ({ useAgentsStore: () => ({ status: "ready", error: null, agents: [], load: async () => {} }) }));
vi.mock("@/components/agents/settings/AutonomySettings", () => ({ AutonomySettings: () => createElement("fieldset", { "data-probe": "autonomy" }) }));
vi.mock("@/components/agents/settings/CiConnections", () => ({ CiConnections: () => createElement("section", { "data-probe": "ci" }) }));
vi.mock("@/components/agents/settings/LessonsList", () => ({ LessonsList: () => null }));
vi.mock("@/components/agents/settings/TelegramConnection", () => ({ TelegramConnection: () => null }));
vi.mock("@/components/agents/settings/AgentList", () => ({ AgentList: () => null }));
vi.mock("@/components/agents/settings/ConnectedApps", () => ({ ConnectedApps: () => null }));
vi.mock("@/components/agents/settings/NewAgentWizard", () => ({ NewAgentWizard: () => null }));
vi.mock("@/components/agents/settings/AgentDetail", () => ({ AgentDetail: () => null }));
vi.mock("@/components/agents/settings/TokenReveal", () => ({ TokenReveal: () => null }));
vi.mock("@/components/agents/settings/EnvironmentList", () => ({ EnvironmentList: () => null }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  store.syncWorkspaceId = "w1";
  document.body.replaceChildren();
});

async function mountTab() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = () => act(async () => root.render(createElement(AgentsSettingsTab)));
  await render();
  const count = (probe: string) => host.querySelectorAll(`[data-probe="${probe}"]`).length;
  return { render, count };
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
