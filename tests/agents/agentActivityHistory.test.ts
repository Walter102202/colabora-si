import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRow, TaskRow } from "@/lib/agentTasks";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { message: string } | null };
type Query = { table: string; equal: Record<string, unknown>; within: Record<string, unknown[]>; lower: Record<string, number>; upper: Record<string, number>; order: { key: string; ascending: boolean }[]; limit?: number };
type Handler = (payload: { new: Row; old?: { id: string }; eventType?: string }) => void;
const records: Record<string, Row[]> = {};
let clientAvailable = true;
const read = vi.fn<(query: Query) => Promise<Result>>();
const handlers = new Map<string, Handler>();
const client = {
  from(table: string) {
    const query: Query = { table, equal: {}, within: {}, lower: {}, upper: {}, order: [] };
    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => { query.equal[key] = value; return chain; },
      is: (key: string, value: unknown) => { query.equal[key] = value; return chain; },
      in: (key: string, value: unknown[]) => { query.within[key] = value; return chain; },
      gt: (key: string, value: number) => { query.lower[key] = value; return chain; },
      lt: (key: string, value: number) => { query.upper[key] = value; return chain; },
      order: (key: string, options?: { ascending: boolean }) => { query.order.push({ key, ascending: options?.ascending ?? true }); return chain; },
      limit: (limit: number) => { query.limit = limit; return chain; },
      then: (resolve: (value: Result) => unknown, reject: (error: unknown) => unknown) => read(query).then(resolve, reject),
    };
    return chain;
  },
  channel: () => {
    const channel = {
      on: (_event: string, filter: { table: string }, handler: Handler) => { handlers.set(filter.table, handler); return channel; },
      subscribe: () => channel,
    };
    return channel;
  },
  realtime: { channels: [] },
  removeChannel: async () => "ok",
};
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => clientAvailable ? client : null, agentErrorMessage: (error: { message?: string }) => error?.message ?? "Could not load activity." }));
const { useAgentTasks, ACTIVITIES_PAGE_SIZE } = await import("@/lib/agentTasks");

const activity = (seq: number, taskId = "task"): ActivityRow => ({
  id: `${taskId}-${seq}`, task_id: taskId, run_id: null, seq, type: "response", body: { text: `Event ${seq}` },
  ephemeral: false, author_type: "agent", author_id: "agent", created_at: `2026-11-04T10:00:00Z`,
});
const asRow = (value: object): Row => value as Row;
const seed = (count: number, taskId = "task", first = 1) => Array.from({ length: count }, (_, index) => activity(first + index, taskId));
const queryRecords = async (query: Query): Promise<Result> => {
  const rows = (records[query.table] ?? []).filter((row) =>
    Object.entries(query.equal).every(([key, value]) => (row[key] ?? null) === value)
    && Object.entries(query.within).every(([key, values]) => values.includes(row[key]))
    && Object.entries(query.lower).every(([key, value]) => Number(row[key]) > value)
    && Object.entries(query.upper).every(([key, value]) => Number(row[key]) < value));
  rows.sort((a, b) => {
    for (const order of query.order) {
      const left = a[order.key] as number | string, right = b[order.key] as number | string;
      const compared = left < right ? -1 : left > right ? 1 : 0;
      if (compared) return order.ascending ? compared : -compared;
    }
    return 0;
  });
  return { data: rows.slice(0, query.limit), error: null };
};
function deferred() {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let release: (() => void) | undefined;
beforeEach(async () => {
  clientAvailable = true;
  for (const key of Object.keys(records)) delete records[key];
  handlers.clear();
  read.mockReset().mockImplementation(queryRecords);
  useAgentTasks.setState(useAgentTasks.getInitialState(), true);
  await useAgentTasks.getState().load("workspace");
  read.mockClear();
});
afterEach(() => { release?.(); release = undefined; });

describe("activity history pagination", () => {
  it("opens the latest page, then reads older records without mutating or replacing it", async () => {
    records.agent_activities = seed(ACTIVITIES_PAGE_SIZE * 2 + 3).map(asRow);
    await useAgentTasks.getState().loadActivities("task");
    const latest = useAgentTasks.getState().activities.task;
    expect(latest).toHaveLength(ACTIVITIES_PAGE_SIZE);
    expect(latest[0].seq).toBe(ACTIVITIES_PAGE_SIZE + 4);
    expect(useAgentTasks.getState().activityHasMore.task).toBe(true);
    await useAgentTasks.getState().loadOlderActivities("task");
    expect(useAgentTasks.getState().activities.task).toHaveLength(ACTIVITIES_PAGE_SIZE * 2);
    expect(latest).toHaveLength(ACTIVITIES_PAGE_SIZE);
    expect(useAgentTasks.getState().activities.task).not.toBe(latest);
    expect(useAgentTasks.getState().activityHasMore.task).toBe(true);
    await useAgentTasks.getState().loadOlderActivities("task");
    expect(useAgentTasks.getState().activities.task.map((row) => row.seq)).toEqual(seed(ACTIVITIES_PAGE_SIZE * 2 + 3).map((row) => row.seq));
    expect(useAgentTasks.getState().activityHasMore.task).toBe(false);
    expect(useAgentTasks.getState().activityLoading.task).toBe(false);
    const requests = read.mock.calls.length;
    await useAgentTasks.getState().loadOlderActivities("task");
    expect(read).toHaveBeenCalledTimes(requests);
  });

  it.each([0, ACTIVITIES_PAGE_SIZE])("does not advertise a nonexistent older page for %s events", async (count) => {
    records.agent_activities = seed(count).map(asRow);
    await useAgentTasks.getState().loadActivities("task");
    expect(useAgentTasks.getState().activities.task).toHaveLength(count);
    expect(useAgentTasks.getState().activityHasMore.task).toBe(false);
  });

  it("uses a separate cursor for each task", async () => {
    records.agent_activities = [...seed(210, "parent"), ...seed(210, "child", 1000)].map(asRow);
    await Promise.all([useAgentTasks.getState().loadActivities("parent"), useAgentTasks.getState().loadActivities("child")]);
    await Promise.all([useAgentTasks.getState().loadOlderActivities("parent"), useAgentTasks.getState().loadOlderActivities("child")]);
    expect(read.mock.calls.filter(([query]) => query.upper.seq).map(([query]) => [query.equal.task_id, query.upper.seq]))
      .toEqual([["parent", 11], ["child", 1010]]);
    expect(useAgentTasks.getState().activities.parent.map((row) => row.task_id)).toEqual(Array(210).fill("parent"));
    expect(useAgentTasks.getState().activities.child.map((row) => row.task_id)).toEqual(Array(210).fill("child"));
  });

  it("merges simultaneous older, newer and realtime events exactly once", async () => {
    records.agent_activities = seed(210).map(asRow);
    release = useAgentTasks.getState().subscribe("workspace");
    await vi.waitFor(() => expect(useAgentTasks.getState().status).toBe("ready"));
    await useAgentTasks.getState().loadActivities("task");
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const older = useAgentTasks.getState().loadOlderActivities("task");
    await vi.waitFor(() => expect(read.mock.calls.at(-1)?.[0].upper.seq).toBe(11));
    records.agent_activities.push(asRow(activity(211)));
    const newest = useAgentTasks.getState().loadActivities("task");
    handlers.get("agent_activities")!({ eventType: "INSERT", new: asRow(activity(211)) });
    await newest;
    expect(useAgentTasks.getState().activityLoading.task).toBe(true);
    gate.resolve({ data: seed(10).reverse().map(asRow), error: null });
    await older;
    expect(useAgentTasks.getState().activities.task.map((row) => row.seq)).toEqual(seed(211).map((row) => row.seq));
    expect(useAgentTasks.getState().activityHasMore.task).toBe(false);
    expect(useAgentTasks.getState().activityLoading.task).toBe(false);
  });

  it("fills a gap behind a realtime signal and bounds each catch-up to a server snapshot", async () => {
    records.agent_activities = seed(210).map(asRow);
    release = useAgentTasks.getState().subscribe("workspace");
    await vi.waitFor(() => expect(useAgentTasks.getState().status).toBe("ready"));
    await useAgentTasks.getState().loadActivities("task");
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const refresh = useAgentTasks.getState().loadActivities("task");
    await vi.waitFor(() => expect(read.mock.calls.at(-1)?.[0].lower.seq).toBe(210));
    records.agent_activities = seed(700).map(asRow);
    handlers.get("agent_activities")!({ eventType: "INSERT", new: asRow(activity(700)) });
    read.mockImplementation(async (query) => {
      const snapshot = await queryRecords(query);
      if (query.table === "agent_activities" && query.limit === 1) {
        records.agent_activities = seed(1000).map(asRow);
        handlers.get("agent_activities")!({ eventType: "INSERT", new: asRow(activity(1000)) });
      }
      return snapshot;
    });
    gate.resolve({ data: seed(201, "task", 211).map(asRow), error: null });
    await refresh;
    expect(useAgentTasks.getState().activities.task.map((row) => row.seq)).toEqual([...seed(690, "task", 11).map((row) => row.seq), 1000]);
    read.mockImplementation(queryRecords).mockClear();
    await useAgentTasks.getState().loadActivities("task");
    expect(read.mock.calls[0][0].lower.seq).toBe(700);
    expect(useAgentTasks.getState().activities.task.map((row) => row.seq)).toEqual(seed(990, "task", 11).map((row) => row.seq));
    expect(useAgentTasks.getState().activityLoading.task).toBe(false);
  });

  it("deduplicates repeated clicks while a history page is loading", async () => {
    records.agent_activities = seed(210).map(asRow);
    await useAgentTasks.getState().loadActivities("task");
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const first = useAgentTasks.getState().loadOlderActivities("task");
    await vi.waitFor(() => expect(useAgentTasks.getState().activityLoading.task).toBe(true));
    await useAgentTasks.getState().loadOlderActivities("task");
    expect(read.mock.calls.filter(([query]) => query.upper.seq)).toHaveLength(1);
    gate.resolve({ data: seed(10).reverse().map(asRow), error: null });
    await first;
  });

  it.each(["server", "network"])("keeps content and a retryable error after a %s failure", async (failure) => {
    records.agent_activities = seed(210).map(asRow);
    await useAgentTasks.getState().loadActivities("task");
    const before = useAgentTasks.getState().activities.task;
    if (failure === "server") read.mockResolvedValueOnce({ data: null, error: { message: "History unavailable" } });
    else read.mockRejectedValueOnce(new Error("History unavailable"));
    await useAgentTasks.getState().loadOlderActivities("task");
    expect(useAgentTasks.getState().activities.task).toBe(before);
    expect(useAgentTasks.getState().activityHasMore.task).toBe(true);
    expect(useAgentTasks.getState().activityLoading.task).toBe(false);
    expect(useAgentTasks.getState().activityErrors.task).toBe("History unavailable");
    await useAgentTasks.getState().loadOlderActivities("task");
    expect(useAgentTasks.getState().activities.task).toHaveLength(210);
    expect(useAgentTasks.getState().activityHasMore.task).toBe(false);
    expect(useAgentTasks.getState().activityErrors.task).toBeUndefined();
  });

  it("can retry an initial failure and can start through the older-history action", async () => {
    read.mockResolvedValueOnce({ data: null, error: { message: "Offline" } });
    await useAgentTasks.getState().loadActivities("task");
    expect(useAgentTasks.getState().activities.task).toBeUndefined();
    expect(useAgentTasks.getState().activityErrors.task).toBe("Offline");
    records.agent_activities = seed(2).map(asRow);
    await useAgentTasks.getState().loadOlderActivities("task");
    expect(useAgentTasks.getState().activities.task).toHaveLength(2);
    expect(useAgentTasks.getState().activityErrors.task).toBeUndefined();
  });

  it("does not let a late initial load reset exhausted history or replace newer event content", async () => {
    records.agent_activities = seed(210).map(asRow);
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const first = useAgentTasks.getState().loadActivities("task");
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await useAgentTasks.getState().loadActivities("task");
    await useAgentTasks.getState().loadOlderActivities("task");
    const updated = { ...activity(210), body: { text: "Updated detail" } };
    useAgentTasks.setState({ activities: { task: [...useAgentTasks.getState().activities.task.slice(0, -1), updated] } });
    gate.resolve({ data: seed(201, "task", 10).reverse().map(asRow), error: null });
    await first;
    expect(useAgentTasks.getState().activities.task).toHaveLength(210);
    expect(useAgentTasks.getState().activities.task.at(-1)).toBe(updated);
    expect(useAgentTasks.getState().activityHasMore.task).toBe(false);
  });

  it("does not create an unreachable gap by combining disjoint initial snapshots", async () => {
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const olderSnapshot = useAgentTasks.getState().loadActivities("task");
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    records.agent_activities = seed(700).map(asRow);
    await useAgentTasks.getState().loadActivities("task");
    gate.resolve({ data: seed(201, "task", 10).reverse().map(asRow), error: null });
    await olderSnapshot;
    expect(useAgentTasks.getState().activities.task[0].seq).toBe(501);
    for (let page = 0; page < 3; page += 1) await useAgentTasks.getState().loadOlderActivities("task");
    expect(useAgentTasks.getState().activities.task.map((row) => row.seq)).toEqual(seed(700).map((row) => row.seq));
    expect(useAgentTasks.getState().activityHasMore.task).toBe(false);
  });

  it.each([false, true])("drops stale history responses after a workspace switch, including switching back (%s)", async (switchBack) => {
    records.agent_activities = seed(210).map(asRow);
    await useAgentTasks.getState().loadActivities("task");
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const pending = useAgentTasks.getState().loadOlderActivities("task");
    await vi.waitFor(() => expect(useAgentTasks.getState().activityLoading.task).toBe(true));
    await useAgentTasks.getState().load("another-workspace");
    if (switchBack) await useAgentTasks.getState().load("workspace");
    gate.resolve({ data: seed(10).map(asRow), error: null });
    await pending;
    const state = useAgentTasks.getState();
    expect([state.activities, state.activityHasMore, state.activityLoading, state.activityErrors]).toEqual([{}, {}, {}, {}]);
  });

  it("clears loading when the final subscription closes and ignores that stale response", async () => {
    records.agent_activities = seed(210).map(asRow);
    release = useAgentTasks.getState().subscribe("workspace");
    await vi.waitFor(() => expect(useAgentTasks.getState().status).toBe("ready"));
    await useAgentTasks.getState().loadActivities("task");
    const before = useAgentTasks.getState().activities.task;
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const pending = useAgentTasks.getState().loadOlderActivities("task");
    await vi.waitFor(() => expect(useAgentTasks.getState().activityLoading.task).toBe(true));
    release(); release = undefined;
    gate.resolve({ data: seed(10).map(asRow), error: null });
    await pending;
    expect(useAgentTasks.getState().activityLoading.task).toBeUndefined();
    expect(useAgentTasks.getState().activities.task).toBe(before);
  });
});

describe("resolving task metadata for a visible database row", () => {
  const task = (id: string, overrides: Partial<TaskRow> = {}): TaskRow => ({ ...(mockCard("1") as TaskCardData).task,
    id, workspace_id: "workspace", row_page_id: "visible-page", request_kind: null, ...overrides });

  it.each(["client", "workspace"])("reports unavailable %s context instead of claiming the row has no task", async (missing) => {
    if (missing === "client") clientAvailable = false;
    else useAgentTasks.setState({ workspaceId: null });
    await expect(useAgentTasks.getState().loadTaskForPage("visible-page")).rejects.toThrow("Task details are unavailable.");
    expect(read).not.toHaveBeenCalled();
  });

  it("loads old closed work without dropping other tasks and keeps an older open task available", async () => {
    const active = task("still-open", { state: "working", updated_at: "2026-10-01T10:00:00Z" });
    const closed = Array.from({ length: 30 }, (_, index) => task(`closed-${index}`, { state: "done", updated_at: "2026-11-04T10:00:00Z" }));
    records.agent_tasks = [active, ...closed, task("other-workspace", { workspace_id: "other" }), task("other-row", { row_page_id: "elsewhere" }), task("hidden-request", { request_kind: "fill" })].map(asRow);
    const previous = { retained: task("retained", { row_page_id: "elsewhere" }) };
    useAgentTasks.setState({ tasks: previous });
    await useAgentTasks.getState().loadTaskForPage("visible-page");
    const tasks = useAgentTasks.getState().tasks;
    expect(Object.keys(tasks)).toHaveLength(22);
    expect(tasks.retained).toBe(previous.retained);
    expect(tasks[active.id]).toEqual(active);
    expect(tasks["other-workspace"]).toBeUndefined();
    expect(tasks["other-row"]).toBeUndefined();
    expect(tasks["hidden-request"]).toBeUndefined();
    expect(previous).toEqual({ retained: previous.retained });
  });

  it("keeps newer realtime state while resolving an old row", async () => {
    release = useAgentTasks.getState().subscribe("workspace");
    await vi.waitFor(() => expect(useAgentTasks.getState().status).toBe("ready"));
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const pending = useAgentTasks.getState().loadTaskForPage("visible-page");
    await vi.waitFor(() => expect(read.mock.calls.some(([query]) => query.equal.row_page_id === "visible-page")).toBe(true));
    const fresh = task("resolved", { state: "done" });
    handlers.get("agent_tasks")!({ eventType: "INSERT", new: asRow(fresh) });
    gate.resolve({ data: [asRow({ ...fresh, state: "working" })], error: null });
    await pending;
    expect(useAgentTasks.getState().tasks.resolved.state).toBe("done");
  });

  it("preserves tasks on failure and reports it to the connector", async () => {
    const previous = { retained: task("retained") };
    useAgentTasks.setState({ tasks: previous });
    read.mockResolvedValueOnce({ data: null, error: { message: "Access unavailable" } });
    await expect(useAgentTasks.getState().loadTaskForPage("visible-page")).rejects.toThrow("Access unavailable");
    expect(useAgentTasks.getState().tasks).toBe(previous);
  });

  it("ignores a task lookup that completes after changing workspace", async () => {
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const pending = useAgentTasks.getState().loadTaskForPage("visible-page");
    await vi.waitFor(() => expect(read.mock.calls.some(([query]) => query.equal.row_page_id === "visible-page")).toBe(true));
    await useAgentTasks.getState().load("another-workspace");
    gate.resolve({ data: [asRow(task("stale"))], error: null });
    await pending;
    expect(useAgentTasks.getState().tasks).toEqual({});
  });

  it("does not surface an old network failure in the next workspace", async () => {
    const gate = deferred();
    read.mockImplementationOnce(() => gate.promise);
    const pending = useAgentTasks.getState().loadTaskForPage("visible-page");
    await vi.waitFor(() => expect(read.mock.calls.some(([query]) => query.equal.row_page_id === "visible-page")).toBe(true));
    await useAgentTasks.getState().load("another-workspace");
    gate.reject(new Error("Old network failure"));
    await expect(pending).resolves.toBeUndefined();
    expect(useAgentTasks.getState().tasks).toEqual({});
  });
});
