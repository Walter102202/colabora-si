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
import type { BriefRow } from "@/lib/agentTasks";
import type { JobCiStatus } from "@/lib/agentCi";
import type { AutonomyLevel, TaskAutonomy } from "@/lib/agentAutonomy";
import { getAgentClient } from "@/lib/agentClient";
import { getTaskAutonomy, setWorkspaceAutonomy } from "@/lib/agentActions";
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
vi.mock("@/lib/agentActions", async (original) => ({ ...await original<typeof import("@/lib/agentActions")>(), getTaskAutonomy: vi.fn() }));
vi.mock("@/lib/agentClient", async (original) => ({ ...await original<typeof import("@/lib/agentClient")>(), getAgentClient: vi.fn() }));

const baseTask = (mockCard("1") as TaskCardData).task;
const task = (id: string, patch: Partial<TaskRow> = {}): TaskRow => ({ ...baseTask, id: `task-${id}`, workspace_id: "workspace", db_page_id: "database", row_page_id: id, title: `Task ${id}`, owner_user_id: "person", state: "working", review_state: "none", acceptance: "pending", brief_stale: false, last_activity_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z", ...patch });
const row = (id: string, patch: Partial<DbRow> = {}): DbRow => ({ id: `row-${id}`, pageId: id, cells: { title: `Task ${id}` }, ...patch });
let root: Root, host: HTMLDivElement;
const lookup = vi.fn<(pageId: string) => Promise<void>>();
const subscribe = vi.fn(() => () => {});
const reviewBrief = vi.fn<(taskId: string, version: number, signal: AbortSignal) => Promise<{ data: Pick<BriefRow, "done_when"> | null; error: unknown }>>();
const reviewCi = vi.fn<(taskId: string, signal: AbortSignal) => Promise<{ data: JobCiStatus | null; error: unknown }>>();
const policy = (level: AutonomyLevel = "ask"): TaskAutonomy => ({ level, requested: null, source: "workspace", workspace_level: level, auto_approved: [], require_approval: [] });
const ciStatus = (patch: Partial<JobCiStatus> = {}): JobCiStatus => ({ state: "none", connected: false, pending_human: [], checks: [], ...patch });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); seen.panel.mockClear(); lookup.mockReset().mockResolvedValue(); subscribe.mockClear();
  useAuthStore.setState({ user: { id: "person" } as User });
  useAgentTasks.setState({ workspaceId: "workspace", status: "ready", error: null, tasks: {}, rowPlans: {}, runs: {}, approvals: {}, activities: {}, reviews: {}, briefs: {}, jobCi: {}, subscribe, loadTaskForPage: lookup, load: vi.fn(async () => {}) });
  useAgentsStore.setState({ workspaceId: "workspace", status: "ready", agents: [{ id: "trama", workspace_id: "workspace", is_platform: true, revoked_at: null, status: "enabled" } as AgentRow], load: vi.fn(async () => {}) });
  vi.mocked(getTaskAutonomy).mockReset().mockResolvedValue(policy());
  reviewBrief.mockReset().mockResolvedValue({ data: { done_when: [] }, error: null });
  reviewCi.mockReset().mockResolvedValue({ data: ciStatus(), error: null });
  vi.mocked(getAgentClient).mockReturnValue({
    from: () => {
      const filters: Record<string, string | number> = {};
      let signal: AbortSignal;
      const query = {
        select: () => query,
        eq: (key: string, value: string | number) => { filters[key] = value; return query; },
        maybeSingle: () => reviewBrief(String(filters.task_id), Number(filters.version), signal),
        abortSignal: (value: AbortSignal) => { signal = value; return query; },
      };
      return query;
    },
    rpc: (name: string, args: Record<string, string>) => name === "set_workspace_autonomy"
      ? Promise.resolve({ data: { level: args.p_level, previous: "ask" }, error: null })
      : { abortSignal: (signal: AbortSignal) => reviewCi(args.p_task_id, signal) },
  } as unknown as NonNullable<ReturnType<typeof getAgentClient>>);
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
const needsYouCount = () => host.querySelectorAll(".task-progress-filter")[1]?.textContent;
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
  await mount(rows, rows, "/p/database?progressRow=old");
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

it("shows the assigned crew and reorders a job on Worker activity while preserving the open draft and route", async () => {
  const rows = [row("older"), row("child", { parentRowId: "row-older" }), row("planned", { parentRowId: "row-older" }), row("newer")];
  const older = task("older", { delegate_agent_id: "lead", named_worker_ids: ["codex", "lead", "codex"] });
  const child = task("child", { parent_task_id: older.id, delegate_agent_id: "muse" });
  const newer = task("newer", { last_activity_at: "2026-11-04T11:00:00Z" });
  setup(rows, [older, child, newer]);
  useAgentTasks.setState({ rowPlans: { planned: { row_page_id: "planned", workspace_id: "workspace", worker_agent_id: "cursor", updated_by: "person", updated_at: "2026-11-04T10:00:00Z" } } });
  useAgentsStore.setState({ agents: [["lead", "Claude Code"], ["codex", "Codex"], ["muse", "Muse Code"], ["cursor", "Cursor"]]
    .map(([id, name]) => ({ id, name, workspace_id: "workspace", status: "enabled" } as AgentRow)) });
  await mount(rows, rows, "/p/database?progressRow=older&marker=keep#block");
  const cards = () => [...host.querySelectorAll<HTMLButtonElement>(".task-progress-task")];
  const titles = () => cards().map((button) => button.firstElementChild?.textContent);
  const olderCard = () => cards().find((button) => button.firstElementChild?.textContent === "Task older")!;
  expect(titles()).toEqual(["Task newer", "Task older"]);
  expect(olderCard().textContent).toContain("Lead: Claude CodeWorkers: Codex, Muse Code, Cursor");
  const feedback = host.querySelector<HTMLTextAreaElement>('[aria-label="Feedback for older"]')!;
  feedback.value = "Preserve this exact review draft";
  const snapshot = structuredClone(rows);
  await act(async () => useAgentTasks.setState((state) => ({ tasks: { ...state.tasks, [child.id]: { ...child, last_activity_at: "2026-11-04T12:00:00Z" } } })));
  expect(titles()).toEqual(["Task older", "Task newer"]);
  expect(olderCard().querySelector("time")?.dateTime).toBe("2026-11-04T12:00:00.000Z");
  expect([...host.querySelectorAll("select option")].map((option) => option.getAttribute("value"))).toEqual(["", "older", "child", "planned", "newer"]);
  expect(selectedControls()).toBe("older");
  expect(host.querySelector('[aria-label="Feedback for older"]')).toBe(feedback);
  expect(feedback.value).toBe("Preserve this exact review draft");
  expect(route()).toBe("/p/database?progressRow=older&marker=keep#block");
  expect(rows).toEqual(snapshot);
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

it("keeps autonomous jobs waiting for CI out of Needs you while explicit approvals still count", async () => {
  const rows = [row("ready")], ready = task("ready", { state: "ready_for_review" }); setup(rows, [ready]);
  vi.mocked(getTaskAutonomy).mockResolvedValue(policy("autonomous"));
  reviewCi.mockResolvedValue({ data: ciStatus({ state: "pending" }), error: null });
  await mount(rows);
  expect(needsYouCount()).toBe("Needs you 0");
  expect(host.querySelector(".task-progress-badge")?.textContent).toBe("Waiting for CI");
  const controls = host.querySelector('[aria-label="Existing task controls"]');
  await act(async () => { useAgentTasks.setState({ approvals: { action: { task_id: ready.id, status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString() } as ApprovalRow } }); });
  expect(needsYouCount()).toBe("Needs you 1");
  expect(host.querySelector(".task-progress-badge")?.textContent).toBe("Needs you");
  expect(host.querySelector('[aria-label="Existing task controls"]')).toBe(controls);
  expect(getTaskAutonomy).toHaveBeenCalledOnce();
});

it("keeps a known person criterion visible while review metadata loads or fails", async () => {
  const rows = [row("ready")], ready = task("ready", { state: "ready_for_review" }); setup(rows, [ready]);
  const brief = { task_id: ready.id, version: ready.brief_version, done_when: [{ id: "human", text: "I approve the result", check: "human", by: "person" }] } as BriefRow;
  useAgentTasks.setState({ briefs: { [`${ready.id}:${ready.brief_version}`]: brief } });
  let fail!: (reason: Error) => void;
  vi.mocked(getTaskAutonomy).mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  reviewCi.mockResolvedValue({ data: ciStatus({ state: "pending" }), error: null });
  await mount(rows);
  expect(needsYouCount()).toBe("Needs you 1");
  expect(reviewBrief).not.toHaveBeenCalled();
  await act(async () => { fail(new Error("network unavailable")); });
  expect(needsYouCount()).toBe("Needs you 1");
  expect(host.textContent).toContain("Acceptance is waiting for CI results");
  expect(textButton("Retry review status")).toBeDefined();
});

it("leaves failed reads neutral, retains saved controls and retries without duplicating unchanged reads", async () => {
  const rows = [row("ready")]; setup(rows, [task("ready", { state: "ready_for_review" })]);
  vi.mocked(getTaskAutonomy).mockRejectedValueOnce(new Error("offline"));
  await mount(rows);
  expect(needsYouCount()).toBe("Needs you 0");
  expect(host.querySelector(".task-progress-badge")?.textContent).toBe("Ready for review");
  const controls = host.querySelector('[aria-label="Existing task controls"]');
  await act(async () => { textButton("Retry review status").click(); });
  expect(needsYouCount()).toBe("Needs you 1");
  expect(textButton("Retry review status")).toBeUndefined();
  expect(getTaskAutonomy).toHaveBeenCalledTimes(2);
  await act(async () => { useAgentTasks.setState({ activities: {} }); });
  await mount(rows);
  expect(getTaskAutonomy).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[aria-label="Existing task controls"]')).toBe(controls);
});

it("keeps missing criterion authorship unknown instead of assuming the agent can settle it", async () => {
  const rows = [row("ready")]; setup(rows, [task("ready", { state: "ready_for_review" })]);
  vi.mocked(getTaskAutonomy).mockResolvedValue(policy("autonomous"));
  reviewBrief.mockResolvedValue({ data: { done_when: [{ id: "historical", text: "Review result", check: "human" }] }, error: null });
  await mount(rows);
  expect(host.querySelector(".task-progress-badge")?.textContent).toBe("Ready for review");
  expect(textButton("Retry review status")).toBeDefined();
  await act(async () => { host.querySelectorAll<HTMLButtonElement>(".task-progress-filter")[1].click(); });
  expect(host.textContent).toContain("Review requirements are not fully available yet");
});

it("keeps a child's person requirement reachable when its parent's review requirements are unknown", async () => {
  const rows = [row("parent"), row("child", { parentRowId: "row-parent" })];
  setup(rows, [task("parent", { state: "ready_for_review" }), task("child", { parent_task_id: "task-parent", state: "ready_for_review", review_state: "approved" })]);
  vi.mocked(getTaskAutonomy).mockResolvedValue(policy("autonomous"));
  reviewCi.mockResolvedValue({ data: null, error: new Error("offline") });
  reviewBrief.mockImplementation(async (id) => ({ data: { done_when: id === "task-child" ? [{ id: "visual", text: "Approve layout", check: "human", by: "person" }] : [] }, error: null }));
  await mount(rows);
  expect(needsYouCount()).toBe("Needs you 1");
  expect(vi.mocked(getTaskAutonomy).mock.calls.every(([id]) => id === "task-parent")).toBe(true);
  await act(async () => { host.querySelectorAll<HTMLButtonElement>(".task-progress-filter")[1].click(); });
  expect(host.querySelectorAll('[aria-label="Tasks and subtasks"] .task-progress-task')).toHaveLength(2);
  await selectTask("Task child");
  expect(selectedControls()).toBe("child");
});

it("ignores an old revision's late policy and refreshes when the workspace policy changes", async () => {
  const rows = [row("ready")], ready = task("ready", { state: "ready_for_review" }); setup(rows, [ready]);
  let finishOld!: (result: TaskAutonomy) => void;
  vi.mocked(getTaskAutonomy).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValue(policy("autonomous"));
  reviewCi.mockResolvedValue({ data: ciStatus({ state: "pending" }), error: null });
  await mount(rows);
  await act(async () => { useAgentTasks.setState({ tasks: { [ready.id]: { ...ready, brief_version: ready.brief_version + 1 } } }); });
  expect(host.querySelector(".task-progress-badge")?.textContent).toBe("Waiting for CI");
  await act(async () => { finishOld(policy("ask")); });
  expect(needsYouCount()).toBe("Needs you 0");
  vi.mocked(getTaskAutonomy).mockResolvedValue(policy("ask"));
  await act(async () => { await setWorkspaceAutonomy("workspace", "ask"); });
  expect(needsYouCount()).toBe("Needs you 1");
  expect(getTaskAutonomy).toHaveBeenCalledTimes(3);
});

it.each(["person", "workspace"] as const)("ignores late review metadata after the %s changes", async (scope) => {
  const rows = [row("ready")], ready = task("ready", { state: "ready_for_review" }); setup(rows, [ready]);
  let finishOld!: (result: TaskAutonomy) => void;
  vi.mocked(getTaskAutonomy).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValue(policy("autonomous"));
  reviewCi.mockResolvedValue({ data: ciStatus({ state: "pending" }), error: null });
  await mount(rows);
  await act(async () => {
    if (scope === "person") {
      useAuthStore.setState({ user: { id: "another-person" } as User });
      useAgentTasks.setState({ tasks: { [ready.id]: { ...ready, owner_user_id: "another-person" } } });
    } else {
      useStore.setState({ syncWorkspaceId: "another-workspace" });
      useAgentTasks.setState({ workspaceId: "another-workspace", tasks: { [ready.id]: { ...ready, workspace_id: "another-workspace" } } });
    }
  });
  await act(async () => { finishOld(policy("ask")); });
  expect(needsYouCount()).toBe("Needs you 0");
  expect(host.querySelector(".task-progress-badge")?.textContent).toBe("Waiting for CI");
});

it("limits pending reads to three and pauses queued work behind Table without losing drafts", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => row(String(index)));
  setup(rows, rows.map((item) => task(item.pageId, { state: "ready_for_review" })));
  const finish: ((value: TaskAutonomy) => void)[] = [];
  vi.mocked(getTaskAutonomy).mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
  await mount(rows);
  expect(getTaskAutonomy).toHaveBeenCalledTimes(3);
  const feedback = host.querySelector<HTMLTextAreaElement>('[aria-label="Feedback for 0"]')!;
  feedback.value = "Keep this draft";
  await mount(rows, rows, "/p/database", false);
  expect(reviewCi.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
  expect(vi.mocked(getTaskAutonomy).mock.calls.every(([, signal]) => signal?.aborted)).toBe(true);
  await act(async () => { finish.forEach((resolve) => resolve(policy("ask"))); });
  expect(getTaskAutonomy).toHaveBeenCalledTimes(3);
  expect(needsYouCount()).toBe("Needs you 0");
  vi.mocked(getTaskAutonomy).mockResolvedValue(policy("autonomous"));
  await mount(rows);
  expect(getTaskAutonomy).toHaveBeenCalledTimes(8);
  expect(needsYouCount()).toBe("Needs you 0");
  expect(host.querySelector('[aria-label="Feedback for 0"]')).toBe(feedback);
  expect(feedback.value).toBe("Keep this draft");
});

it("revalidates a completed policy read when returning from Table without a window focus event", async () => {
  const rows = [row("ready")]; setup(rows, [task("ready", { state: "ready_for_review" })]);
  await mount(rows);
  expect(needsYouCount()).toBe("Needs you 1");
  await mount(rows, rows, "/p/database", false);
  vi.mocked(getTaskAutonomy).mockResolvedValue(policy("autonomous"));
  reviewCi.mockResolvedValue({ data: ciStatus({ state: "pending" }), error: null });
  await mount(rows);
  expect(needsYouCount()).toBe("Needs you 0");
  expect(host.querySelector(".task-progress-badge")?.textContent).toBe("Waiting for CI");
  expect(getTaskAutonomy).toHaveBeenCalledTimes(2);
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
