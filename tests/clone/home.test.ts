// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { User } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Home from "@/app/(workspace)/page";
import { useAgentTasks, type TaskRow } from "@/lib/agentTasks";
import { useAgentsStore } from "@/lib/agentsStore";
import { useAuthStore } from "@/lib/auth";
import { useStore } from "@/lib/store";

vi.mock("@/lib/agentClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentClient")>()),
  getAgentClient: () => ({}),
}));

const task: TaskRow = {
  id: "t1", workspace_id: "ws-1", context_id: "c1", db_page_id: "db", row_page_id: "row-1", title: "Weekly summary",
  delegate_agent_id: null, owner_user_id: "u-1", parent_task_id: null, depends_on_task_ids: [], state: "input_required",
  review_state: "none", acceptance: "pending", waiting_on: "human", brief_version: 1, brief_stale: false, active_run_id: null,
  review_rounds: 0, max_review_rounds: 3, cost_usd: 0, last_activity_at: null, created_at: "2026-10-30T09:00:00Z",
  updated_at: "2026-10-30T09:00:00Z", closed_at: null, closed_by: null,
};

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  // The backend is replaced: the agent stores answer from memory for the signed-in person.
  useAuthStore.setState({ user: { id: "u-1" } as User, loading: false });
  useAgentTasks.setState({ subscribe: () => () => {}, status: "ready", error: null, load: async () => {}, tasks: { t1: task }, approvals: {}, runs: {} });
  useAgentsStore.setState({ load: async () => {}, agents: [] });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const mount = () => act(() => root.render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(Home))));

it("HOME-1 shows the decisions above the recent pages for a signed-in person", () => {
  useStore.setState({ syncWorkspaceId: "ws-1", syncUserId: "u-1" });
  mount();
  const decisions = container.querySelector('section[aria-label="Decisions"]');
  expect(decisions?.textContent).toContain("Weekly summary");
  const recent = [...container.querySelectorAll("h2")].find((h) => h.textContent === "Recently edited");
  expect(recent).toBeDefined();
  expect(decisions!.compareDocumentPosition(recent!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it("HOME-2 shows nothing of the agent layer without a synced workspace", () => {
  useStore.setState({ syncWorkspaceId: null, syncUserId: null });
  mount();
  expect(container.querySelector('section[aria-label="Decisions"]')).toBeNull();
  expect(container.textContent).toContain("Recently edited");
});
