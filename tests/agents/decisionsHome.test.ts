// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DecisionsHome } from "@/components/agents/DecisionsHome";
import { useAuthStore } from "@/lib/auth";
import { useAgentTasks, type TaskRow } from "@/lib/agentTasks";
import { useAgentsStore } from "@/lib/agentsStore";
import { useStore } from "@/lib/store";

// The plug mounted on the real stores; only the backend client is replaced (null means no backend).
const { backend } = vi.hoisted(() => ({ backend: { client: {} as object | null } }));
vi.mock("@/lib/agentClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentClient")>()),
  getAgentClient: () => backend.client,
}));

const signIn = (id: string | null) => useAuthStore.setState({ user: id ? ({ id } as User) : null, loading: false });
const doneTask = (closedAt: string): TaskRow => ({
  id: "t1", workspace_id: "w1", context_id: "ctx-1", db_page_id: "db1", row_page_id: "row-1", title: "Ship the summary",
  delegate_agent_id: null, owner_user_id: "u-me", parent_task_id: null, depends_on_task_ids: [], state: "done",
  review_state: "none", acceptance: "accepted", waiting_on: null, brief_version: 1, brief_stale: false, active_run_id: null,
  review_rounds: 0, max_review_rounds: 3, cost_usd: 0, last_activity_at: closedAt, created_at: closedAt, updated_at: closedAt,
  closed_at: closedAt, closed_by: "u-me",
});

let container: HTMLDivElement;
let root: Root;
let subscribe: Mock<(workspaceId: string) => () => void>;
let release: Mock<() => void>;
let load: Mock<(workspaceId: string) => Promise<void>>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  backend.client = {};
  release = vi.fn<() => void>();
  subscribe = vi.fn<(workspaceId: string) => () => void>(() => release);
  load = vi.fn<(workspaceId: string) => Promise<void>>(async () => {});
  useStore.setState({ syncWorkspaceId: "w1", syncUserId: "u-me" });
  signIn("u-me");
  useAgentTasks.setState({ status: "idle", error: null, tasks: {}, approvals: {}, runs: {}, subscribe, load });
  useAgentsStore.setState({ agents: [], load: async () => {} });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
const mount = () => act(() => root.render(createElement(DecisionsHome)));

describe("DecisionsHome", () => {
  it("says the load failed and retries it, instead of showing empty sections", () => {
    useAgentTasks.setState({ status: "error", error: "Failed to fetch" });
    mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not load decisions: Failed to fetch");
    expect(container.textContent).not.toContain("Nothing waits for your decision.");
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(load).toHaveBeenCalledWith("w1");
  });

  it("loads again when the browser comes back online after a failed load", () => {
    useAgentTasks.setState({ status: "error", error: "Failed to fetch" });
    mount();
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(load).toHaveBeenCalledWith("w1");
    act(() => useAgentTasks.setState({ status: "ready", error: null }));
    load.mockClear();
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(load).not.toHaveBeenCalled();
  });

  it("renders nothing without a backend, even with sync ids persisted from an earlier session", () => {
    backend.client = null;
    mount();
    expect(container.innerHTML).toBe("");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("hides and lets go of the tasks when the person signs out, and stays hidden for another account", () => {
    mount();
    expect(subscribe).toHaveBeenCalledWith("w1");
    expect(container.querySelector("[aria-busy=true]")?.textContent).toBe("Loading decisions…");
    act(() => signIn(null));
    expect(container.innerHTML).toBe("");
    expect(release).toHaveBeenCalledTimes(1);
    act(() => signIn("u-other")); // the sync ids still name the previous person until sync rebinds them
    expect(container.innerHTML).toBe("");
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("drops what closed yesterday once the day rolls over, without a reload", () => {
    const midnight = new Date(2026, 9, 31).getTime(); // local midnight, so the test holds in any time zone
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(midnight - 30_000);
    useAgentTasks.setState({ status: "ready", tasks: { t1: doneTask(new Date(midnight - 3_600_000).toISOString()) } });
    mount();
    expect(container.textContent).toContain("Done today (1)");
    expect(container.textContent).toContain("Ship the summary");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(container.textContent).toContain("Done today (0)");
  });
});
