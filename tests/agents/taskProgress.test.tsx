// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import { TaskProgress } from "@/components/agents/TaskProgress";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import { useStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth";
import { useAgentTasks, type ApprovalRow, type TaskRow } from "@/lib/agentTasks";
import { useAgentsStore, type AgentRow } from "@/lib/agentsStore";
import { createPage } from "@/lib/factories";
import { progressReadKey } from "@/lib/agentProgress";
import { TRAMA_TASK_DRAFT_EVENT, type TramaTaskDraft } from "@/lib/agentTramaContext";
import type { DbRow } from "@/lib/types";

const seen = vi.hoisted(() => ({ panel: vi.fn() }));
vi.mock("@/components/agents/RowPanel", () => ({
  RowPanel: (props: { pageId: string; embedded?: boolean }) => {
    seen.panel(props);
    return <div aria-label="Existing task controls" data-page={props.pageId}>Saved task controls<textarea aria-label={`Feedback for ${props.pageId}`} defaultValue="" /></div>;
  },
}));

const baseTask = (mockCard("1") as TaskCardData).task;
const task = (id: string, patch: Partial<TaskRow> = {}): TaskRow => ({ ...baseTask, id: `task-${id}`, workspace_id: "workspace", db_page_id: "database", row_page_id: id, title: `Task ${id}`, owner_user_id: "person", state: "working", review_state: "none", acceptance: "pending", brief_stale: false, last_activity_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z", ...patch });
const row = (id: string, patch: Partial<DbRow> = {}): DbRow => ({ id: `row-${id}`, pageId: id, cells: { title: `Task ${id}` }, ...patch });
let root: Root, host: HTMLDivElement;
const lookup = vi.fn<(pageId: string) => Promise<void>>();
const subscribe = vi.fn(() => () => {});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); seen.panel.mockClear(); lookup.mockReset().mockResolvedValue(); subscribe.mockClear();
  useAuthStore.setState({ user: { id: "person" } as User });
  useAgentTasks.setState({ workspaceId: "workspace", status: "ready", error: null, tasks: {}, runs: {}, approvals: {}, activities: {}, reviews: {}, subscribe, loadTaskForPage: lookup, load: vi.fn(async () => {}) });
  useAgentsStore.setState({ workspaceId: "workspace", status: "ready", agents: [{ id: "trama", workspace_id: "workspace", is_platform: true, revoked_at: null, status: "enabled" } as AgentRow], load: vi.fn(async () => {}) });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(rows: DbRow[], tasks: TaskRow[] = []) {
  const pages = Object.fromEntries(rows.map((record) => [record.pageId, createPage({ id: record.pageId, parentId: "database", title: String(record.cells.title) })]));
  useStore.setState({ pages, syncWorkspaceId: "workspace", syncUserId: "person" });
  useAgentTasks.setState({ tasks: Object.fromEntries(tasks.map((record) => [record.id, record])) });
}
function Route() {
  const location = useLocation(), navigate = useNavigate();
  return <><output aria-label="Current route">{location.pathname + location.search + location.hash}</output><button type="button" onClick={() => void navigate(-1)}>Browser back</button></>;
}
async function mount(rows: DbRow[], allRows = rows, path = "/p/database", active = true) {
  await act(async () => { root.render(<MemoryRouter initialEntries={[path]}><TaskProgress pageId="database" rows={rows} allRows={allRows} active={active} /><Route /></MemoryRouter>); });
}
const textButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
const selectedControls = () => host.querySelector('[data-progress-panel]:not([hidden]) [aria-label="Existing task controls"]')?.getAttribute("data-page");
const route = () => host.querySelector('[aria-label="Current route"]')!.textContent!;
const selectTask = async (title: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Tasks and subtasks"] .task-progress-task')].find((item) => item.firstElementChild?.textContent === title)!;
  expect(button).toBeDefined();
  await act(async () => { button.click(); });
};

it("keeps old database rows in the inventory and loads their own metadata before showing controls", async () => {
  const rows = Array.from({ length: 55 }, (_, index) => row(String(index)));
  setup(rows, [task("0")]);
  let finish!: () => void;
  lookup.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  await mount(rows);
  expect(host.querySelectorAll('[aria-label="Tasks and subtasks"] .task-progress-task')).toHaveLength(55);
  expect(lookup).not.toHaveBeenCalled();
  await selectTask("Task 54");
  expect(lookup).toHaveBeenCalledWith("54");
  expect(selectedControls()).toBeUndefined();
  expect(host.querySelector('[aria-label="Selected task"]')?.textContent).toContain("Loading saved work");
  await act(async () => {
    const old = task("54", { state: "done", acceptance: "accepted", closed_at: "2026-10-01T00:00:00Z" });
    useAgentTasks.setState((state) => ({ tasks: { ...state.tasks, [old.id]: old } }));
    finish();
  });
  expect(selectedControls()).toBe("54");
  expect(host.querySelector('[aria-current="true"] .task-progress-badge')?.textContent).toBe("Accepted");
  expect(seen.panel).toHaveBeenCalledWith(expect.objectContaining({ embedded: true, pageId: "54" }));
});

it("shows lookup failure instead of pretending an old task is unassigned and allows a read-only retry", async () => {
  const rows = [row("old")]; setup(rows);
  lookup.mockRejectedValueOnce(new Error("offline"));
  await mount(rows);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load this task");
  expect(seen.panel).not.toHaveBeenCalled();
  expect(selectedControls()).toBeUndefined();
  await act(async () => { textButton("Try again").click(); });
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(selectedControls()).toBe("old");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("discards a failed lookup after the person selects a different task", async () => {
  const rows = [row("old"), row("current")]; setup(rows, [task("current")]);
  let fail!: (reason: Error) => void;
  lookup.mockImplementation(() => new Promise<void>((_, reject) => { fail = reject; }));
  await mount(rows);
  await selectTask("Task current");
  await act(async () => { fail(new Error("late failure")); });
  expect(selectedControls()).toBe("current");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps the current task controls mounted during a background refresh", async () => {
  const rows = [row("current")]; setup(rows, [task("current")]);
  await mount(rows);
  const controls = host.querySelector('[aria-label="Existing task controls"]');
  expect(controls).not.toBeNull();
  await act(async () => { useAgentTasks.setState({ status: "loading" }); });
  expect(host.querySelector('[aria-label="Existing task controls"]')).toBe(controls);
  await act(async () => { useAgentTasks.setState({ status: "ready" }); });
  expect(host.querySelector('[aria-label="Existing task controls"]')).toBe(controls);
});

it("preserves independent unsent drafts when switching tasks and hides inactive controls", async () => {
  const rows = [row("first"), row("second")]; setup(rows, [task("first"), task("second")]);
  await mount(rows);
  const first = host.querySelector<HTMLTextAreaElement>('[aria-label="Feedback for first"]')!;
  first.value = "My first task feedback";
  await selectTask("Task second");
  const second = host.querySelector<HTMLTextAreaElement>('[aria-label="Feedback for second"]')!;
  second.value = "Different feedback for the second task";
  expect(first.closest("[data-progress-panel]")?.hasAttribute("hidden")).toBe(true);
  expect(first.closest("[data-progress-panel]")?.hasAttribute("inert")).toBe(true);
  expect(selectedControls()).toBe("second");
  await selectTask("Task first");
  expect(host.querySelector('[aria-label="Feedback for first"]')).toBe(first);
  expect(first.value).toBe("My first task feedback");
  await selectTask("Task second");
  expect(second.value).toBe("Different feedback for the second task");
});

it("keeps a new row selected outside a saved filter without changing or dropping the other rows", async () => {
  const matching = row("matching"), hidden = row("new"), all = [matching, hidden], snapshot = structuredClone(all);
  setup(all, [task("matching")]);
  await mount([matching], all, "/p/database?progressRow=new&marker=keep#block");
  expect(selectedControls()).toBe("new");
  expect(host.querySelector('[aria-label="Selected task"]')?.textContent).toContain("outside the current filter");
  expect(route()).toBe("/p/database?progressRow=new&marker=keep#block");
  expect(all).toEqual(snapshot);
});

it("does not silently substitute another task when the selected row is gone", async () => {
  const rows = [row("present")]; setup(rows, [task("present")]);
  await mount(rows, rows, "/p/database?progressRow=missing");
  expect(host.querySelector('[aria-label="Selected task"]')?.textContent).toContain("no longer in this database");
  expect(selectedControls()).toBeUndefined();
  expect(lookup).not.toHaveBeenCalled();
  expect(route()).toContain("progressRow=missing");
});

it("preserves URL selection, ancillary queries and hashes through task changes and browser back", async () => {
  const rows = [row("first"), row("second")]; setup(rows, [task("first"), task("second")]);
  await mount(rows, rows, "/p/database?marker=keep#block");
  expect(route()).toBe("/p/database?marker=keep&progressRow=first#block");
  await selectTask("Task second");
  expect(selectedControls()).toBe("second");
  expect(new URL(route(), "https://colabora.si").searchParams.has("task")).toBe(false);
  await act(async () => { textButton("Browser back").click(); });
  expect(selectedControls()).toBe("first");
  expect(route()).toBe("/p/database?marker=keep&progressRow=first#block");
});

it("does not take over the URL while retained behind the table", async () => {
  const rows = [row("first")]; setup(rows, [task("first")]);
  await mount(rows, rows, "/p/database?taskLayout=table&marker=keep#block", false);
  expect(route()).toBe("/p/database?taskLayout=table&marker=keep#block");
});

it("counts a parent acceptance once while keeping a child's independent pending decision reachable", async () => {
  const rows = [row("parent"), row("child", { parentRowId: "row-parent" })];
  setup(rows, [task("parent", { state: "ready_for_review" }), task("child", { parent_task_id: "task-parent", state: "ready_for_review", review_state: "approved" })]);
  await mount(rows);
  const needsYou = [...host.querySelectorAll<HTMLButtonElement>(".task-progress-filter")].find((button) => button.textContent?.startsWith("Needs you"))!;
  expect(needsYou.textContent).toBe("Needs you 1");
  await act(async () => { needsYou.click(); });
  expect(host.querySelectorAll('[aria-label="Tasks and subtasks"] .task-progress-task')).toHaveLength(1);
  await act(async () => { useAgentTasks.setState({ approvals: { independent: { id: "independent", task_id: "task-child", kind: "action", status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString() } as ApprovalRow } }); });
  expect(needsYou.textContent).toBe("Needs you 2");
  expect(host.querySelectorAll('[aria-label="Tasks and subtasks"] .task-progress-task')).toHaveLength(2);
  await selectTask("Task child");
  expect(selectedControls()).toBe("child");
});

it("opens a Trama draft for the selected task only after a click without changing tasks or pages", async () => {
  const rows = [row("first"), row("second")]; setup(rows, [task("first"), task("second")]);
  const listener = vi.fn(); window.addEventListener(TRAMA_TASK_DRAFT_EVENT, listener);
  const pages = useStore.getState().pages, tasks = useAgentTasks.getState().tasks;
  try {
    await mount(rows);
    await selectTask("Task second");
    expect(listener).not.toHaveBeenCalled();
    await act(async () => { textButton("What changed?").click(); });
    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0][0] as CustomEvent<TramaTaskDraft>;
    expect(event.detail).toMatchObject({ workspaceId: "workspace", taskId: "task-second", pageId: "second" });
    expect(event.detail.prompt).toContain("meaningful progress");
    expect(useStore.getState().pages).toBe(pages);
    expect(useAgentTasks.getState().tasks).toBe(tasks);
  } finally { window.removeEventListener(TRAMA_TASK_DRAFT_EVENT, listener); }
});

it("keeps read markers isolated when people or workspaces change on the same device", async () => {
  const rows = [row("first")], original = task("first"); setup(rows, [original]);
  await mount(rows);
  expect(host.textContent).not.toContain("New activity since you last checked");
  await act(async () => { textButton("Mark this point as read").click(); });
  const firstKey = progressReadKey("workspace", "person", "database");
  expect(JSON.parse(localStorage.getItem(firstKey)!)).toEqual({ "task-first": original.last_activity_at });
  await act(async () => {
    useAgentTasks.setState({ tasks: { [original.id]: { ...original, last_activity_at: "2026-11-04T11:00:00Z" } } });
    useAuthStore.setState({ user: { id: "another-person" } as User });
  });
  expect(host.textContent).not.toContain("New activity since you last checked");
  expect(textButton("Mark this point as read")).toBeDefined();
  await act(async () => { textButton("Mark this point as read").click(); });
  const secondKey = progressReadKey("workspace", "another-person", "database");
  expect(localStorage.getItem(secondKey)).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(firstKey)!)).toEqual({ "task-first": original.last_activity_at });
  await act(async () => { useAuthStore.setState({ user: { id: "person" } as User }); });
  expect(host.textContent).toContain("New activity since you last checked");
  await act(async () => {
    useStore.setState({ syncWorkspaceId: "other-workspace" });
    useAgentTasks.setState({ workspaceId: "other-workspace", tasks: { [original.id]: { ...original, workspace_id: "other-workspace" } } });
  });
  expect(host.textContent).not.toContain("New activity since you last checked");
  await act(async () => { textButton("Mark this point as read").click(); });
  expect(localStorage.getItem(progressReadKey("other-workspace", "person", "database"))).not.toBeNull();
});

it("keeps a temporary read marker if the browser cannot save preferences", async () => {
  const rows = [row("first")], original = task("first"); setup(rows, [original]);
  await mount(rows);
  const blockedSave = vi.fn(() => { throw new Error("storage blocked"); });
  vi.stubGlobal("localStorage", { getItem: localStorage.getItem.bind(localStorage), setItem: blockedSave });
  await act(async () => { textButton("Mark this point as read").click(); });
  expect(blockedSave).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("read marker lasts for this visit");
  expect(host.textContent).toContain("Your browser could not save it");
  expect(selectedControls()).toBe("first");
});

it("never displays task metadata from a previously open workspace", async () => {
  const rows = [row("first")]; setup(rows);
  useAgentTasks.setState({ workspaceId: "other-workspace", tasks: { wrong: task("first", { workspace_id: "other-workspace", state: "done", acceptance: "accepted" }) } });
  await mount(rows);
  expect(selectedControls()).toBeUndefined();
  expect(host.querySelector('[aria-label="Selected task"]')?.textContent).not.toContain("Accepted");
  expect(lookup).not.toHaveBeenCalled();
});
