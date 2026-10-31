// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LessonsHome } from "@/components/agents/LessonsHome";
import { HomeCards } from "@/components/agents/panel/HomeCards";
import { LessonCard } from "@/components/agents/panel/LessonCard";
import type { User } from "@supabase/supabase-js";
import { useAuthStore } from "@/lib/auth";
import { getAgentClient } from "@/lib/agentClient";
import { useAgentSources } from "@/lib/agentSources";
import { useAgentLessons } from "@/lib/agentLessons";
import { acceptedLessons, proposalsOfTask, proposedLessons, type LessonRow, type LessonScope } from "@/lib/agentLessons";
import { buildDecisionsHome } from "@/lib/agentHome";
import { taskForPage, type AgentTasksState, type TaskRow } from "@/lib/agentTasks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); });

const lesson = (over: Partial<LessonRow> = {}): LessonRow => ({ id: "l1", workspace_id: "w", status: "proposed", body: "Dates are DD/MM/YYYY", example: "30/10/2026",
  scope: "page", scope_page_id: "db", scope_context_id: null, source_kind: "review", source_task_id: "t1", source_text: "c1 contradicted: wrong dates",
  decided_at: null, created_at: "2026-10-30T10:00:00Z", ...over });
const scopes: LessonScope[] = [{ scope: "context", label: "This project", context_id: "c" }, { scope: "page", label: "Reports", page_id: "db" }, { scope: "workspace", label: "Whole workspace" }];

function render(element: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(element));
  return host;
}
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;

describe("LessonCard", () => {
  it("shows what was really corrected and the current scope", () => {
    const host = render(createElement(LessonCard, { lesson: lesson(), scopes, onDecide: vi.fn() }));
    expect(host.textContent).toContain("c1 contradicted: wrong dates");
    expect((host.querySelector("select") as HTMLSelectElement).value).toBe("1");
  });
  it("accepts with the chosen scope", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const host = render(createElement(LessonCard, { lesson: lesson(), scopes, onDecide }));
    await act(async () => { button(host, "Accept").click(); });
    expect(onDecide).toHaveBeenCalledWith("accept", { text: "Dates are DD/MM/YYYY", example: "30/10/2026", scope: scopes[1] });
  });
  it("shows the server's refusal and stays open", async () => {
    const host = render(createElement(LessonCard, { lesson: lesson(), scopes, onDecide: vi.fn().mockRejectedValue(new Error("Only the workspace owner")) }));
    await act(async () => { button(host, "Accept").click(); });
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Only the workspace owner");
  });
});

it("the home section renders nothing when nothing waits", () => {
  expect(render(createElement(HomeCards, { title: "Lessons to review", items: [] })).childElementCount).toBe(0);
});

describe("selectors", () => {
  it("separate proposals, accepted lessons and tasks", () => {
    const rows = { a: lesson({ id: "a" }), b: lesson({ id: "b", status: "accepted", decided_at: "2026-10-30T11:00:00Z" }), c: lesson({ id: "c", source_task_id: "t2" }) };
    expect(proposedLessons(rows).map((l) => l.id)).toEqual(["a", "c"]);
    expect(acceptedLessons(rows).map((l) => l.id)).toEqual(["b"]);
    expect(proposalsOfTask(rows, "t2").map((l) => l.id)).toEqual(["c"]);
  });
});

describe("request tasks stay out of the task views", () => {
  const task = (over: Partial<TaskRow>) => ({ id: "t", row_page_id: "p", state: "working", owner_user_id: "u", updated_at: "2026-10-30T10:00:00Z",
    last_activity_at: null, closed_at: null, title: "Report", delegate_agent_id: null, active_run_id: null, request_kind: null, ...over }) as TaskRow;
  it("a request on the row does not take the panel", () => {
    const state = { tasks: { work: task({ id: "work", state: "done" }), req: task({ id: "req", request_kind: "lesson" }) } } as unknown as AgentTasksState;
    expect(taskForPage(state, "p")?.id).toBe("work");
  });
  it("a request alone leaves the row without a task", () => {
    const state = { tasks: { req: task({ id: "req", request_kind: "source_check" }) } } as unknown as AgentTasksState;
    expect(taskForPage(state, "p")).toBeNull();
  });
  it("a request is not an agent working for the person", () => {
    const home = buildDecisionsHome({ tasks: [task({ id: "req", request_kind: "lesson" })], approvals: [], runs: {}, agents: [], userId: "u", now: Date.parse("2026-10-30T12:00:00Z") });
    expect(home.working).toEqual([]);
  });
});


vi.mock("@/lib/agentClient", async (original) => ({
  ...await original<typeof import("@/lib/agentClient")>(), getAgentClient: vi.fn(() => null),
}));

// One backend fixture exercises both learning stores' isolation boundary.
function learningBackend() {
  type Reply = { data: unknown[] | null; error: { message: string } | null };
  const pending: { table: string; workspace: string; resolve: (reply: Reply) => void }[] = [];
  const channels: { callbacks: Record<string, (payload: unknown) => void>; removed: boolean }[] = [];
  const client = {
    from(table: string) {
      let workspace = "";
      const query = {
        select: () => query, order: () => query,
        eq: (key: string, value: string) => { if (key === "workspace_id") workspace = value; return query; },
        limit: () => new Promise<Reply>((resolve) => pending.push({ table, workspace, resolve })),
      };
      return query;
    },
    realtime: { channels: [] },
    channel() {
      const entry = { callbacks: {} as Record<string, (payload: unknown) => void>, removed: false };
      const ch = { ...entry, on: (_event: string, filter: { table: string }, callback: (payload: unknown) => void) => { ch.callbacks[filter.table] = callback; return ch; }, subscribe: () => ch };
      channels.push(ch);
      return ch;
    },
    removeChannel: async (channel: { removed: boolean }) => { channel.removed = true; },
  };
  vi.mocked(getAgentClient).mockReturnValue(client as unknown as NonNullable<ReturnType<typeof getAgentClient>>);
  const finish = (workspace: string, id: string, failed = false) => {
    for (const request of pending.splice(0).filter((request) => {
      if (request.workspace === workspace) return true;
      pending.push(request); return false;
    })) request.resolve({ data: failed ? null : [{ id, workspace_id: workspace, status: "proposed" }], error: failed ? { message: "forbidden" } : null });
  };
  return { finish, channels };
}

for (const [name, store, records, table] of [
  ["lessons", useAgentLessons, () => useAgentLessons.getState().lessons, "lessons"],
  ["sources", useAgentSources, () => useAgentSources.getState().sources, "page_sources"],
] as const) describe(`${name} isolation`, () => {
  const signIn = () => act(() => useAuthStore.setState({ user: { id: "person" } as User, loading: false }));
  afterEach(() => { act(() => useAuthStore.setState({ user: null })); vi.mocked(getAgentClient).mockReturnValue(null); });

  it("clears workspace A before a failed workspace B load", async () => {
    signIn(); const backend = learningBackend();
    const a = store.getState().load("a"); backend.finish("a", "secret-a"); await a;
    expect(Object.keys(records())).toEqual(["secret-a"]);
    const b = store.getState().load("b");
    expect(records()).toEqual({});
    backend.finish("b", "", true); await b;
    expect(records()).toEqual({});
  });

  it("ignores A's response after B becomes current", async () => {
    signIn(); const backend = learningBackend();
    const a = store.getState().load("a"), b = store.getState().load("b");
    backend.finish("b", "visible-b"); await b;
    backend.finish("a", "secret-a"); await a;
    expect(Object.keys(records())).toEqual(["visible-b"]);
  });

  it("fences records and pending loads when the account session changes", async () => {
    signIn(); const backend = learningBackend();
    const loaded = store.getState().load("a"); backend.finish("a", "old-session"); await loaded;
    const pending = store.getState().load("a");
    // A new auth session for the same person must not inherit the old session's cached reads.
    signIn();
    expect(records()).toEqual({});
    backend.finish("a", "late-old-session"); await pending;
    expect(records()).toEqual({});
  });

  it("ignores released realtime channels and an old subscriber cannot close the new channel", async () => {
    signIn(); const backend = learningBackend();
    const releaseA = store.getState().subscribe("a");
    backend.finish("a", "old"); await Promise.resolve();
    const releaseB = store.getState().subscribe("b");
    backend.finish("b", "current"); await Promise.resolve(); await Promise.resolve();
    releaseA();
    expect(backend.channels[1].removed).toBe(false);
    backend.channels[0].callbacks[table]({ eventType: "INSERT", new: { id: "secret-a", workspace_id: "a" }, old: {} });
    expect(records()).not.toHaveProperty("secret-a");
    releaseB();
  });
});

it("the lessons home never renders another workspace's cached proposal", () => {
  act(() => useAuthStore.setState({ user: { id: "person" } as User, loading: false }));
  useAgentLessons.setState({ lessons: { a: lesson({ id: "a", workspace_id: "a", body: "Private A" }), b: lesson({ id: "b", workspace_id: "b", body: "Visible B" }) } });
  const host = render(createElement(LessonsHome, { workspaceId: "b" }));
  expect([...host.querySelectorAll("textarea")].map((input) => input.value)).toEqual(["Visible B"]);
});
