import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockCard } from "@/components/agents/card/mock";
import { buildDecisionsHome } from "@/lib/agentHome";
import type { TaskCardData } from "@/lib/agentCard";

// Many cells and one row panel subscribe to the same workspace: they must share
// one realtime channel, which closes only when the last subscriber releases.
// The fake client mirrors supabase-js: `channel(topic)` hands back the channel
// registered under that topic until `removeChannel` has run, and a subscribed
// channel refuses new `on` callbacks.
type ChangeHandler = (payload: { new: Record<string, unknown>; old?: { id: string }; eventType?: string }) => void;
type Chan = { topic: string; subscribed: boolean; handlers: Map<string, ChangeHandler>; on(event?: string, filter?: { table: string }, callback?: ChangeHandler): Chan; status?: (status: string) => void; subscribe(callback?: (status: string) => void): Chan };
const registry = new Map<string, Chan>();
const created: Chan[] = [];
const removed: Chan[] = [];
type ReadResult = { data: Record<string, unknown>[]; error: null | { message: string } };
const read = vi.fn<(table: string, filters: Record<string, unknown>) => Promise<ReadResult>>();
const client = {
  channel(name: string) {
    const topic = `realtime:${name}`;
    const existing = registry.get(topic);
    if (existing) return existing;
    const ch: Chan = {
      topic,
      subscribed: false,
      handlers: new Map(),
      on(_event, filter, callback) {
        if (ch.subscribed) throw new Error(`cannot add callbacks for ${topic} after subscribe()`);
        if (filter && callback) ch.handlers.set(filter.table, callback);
        return ch;
      },
      subscribe(callback) { ch.status = callback; ch.subscribed = true; return ch; },
    };
    registry.set(topic, ch);
    created.push(ch);
    return ch;
  },
  realtime: {
    get channels() { return [...registry.values()]; },
    set channels(list: Chan[]) { for (const t of [...registry.keys()]) if (!list.some((c) => c.topic === t)) registry.delete(t); },
  },
  removeChannel(ch: Chan) {
    removed.push(ch);
    return Promise.resolve().then(() => { registry.delete(ch.topic); return "ok"; });
  },
  // Any filter chain resolves to an empty page, like a PostgREST builder that is awaited.
  rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  from(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "gt", "lt", "or", "order", "limit", "is"]) chain[m] = () => chain;
    for (const m of ["eq", "in"]) chain[m] = (key: string, value: unknown) => { filters[key] = value; return chain; };
    chain.then = (resolve: (value: ReadResult) => unknown) => read(table, filters).then(resolve);
    return chain as { select: () => typeof chain };
  },
};
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => client, agentErrorMessage: (e: unknown) => String(e) }));

const { useAgentTasks } = await import("@/lib/agentTasks");
const { useAgentNotifications } = await import("@/lib/agentNotifications");

beforeEach(() => { read.mockReset().mockResolvedValue({ data: [], error: null }); registry.clear(); created.length = 0; removed.length = 0; client.rpc.mockReset().mockResolvedValue({ data: [], error: null }); });

describe("useAgentTasks.subscribe", () => {
  it("reconciles offline task progress and resolved approvals after reconnect", async () => {
    const fixture = mockCard("approval") as TaskCardData;
    let task = { ...fixture.task, state: "input_required", waiting_on: "human" };
    let approvals: Record<string, unknown>[] = [{ ...fixture.approval, id: "decision", task_id: task.id, status: "pending" }];
    read.mockImplementation(async (table, filters) => ({ data: table === "agent_tasks"
      ? (filters.state as string[]).includes(task.state) ? [task] : []
      : table === "agent_approvals" ? approvals : [], error: null }));
    const release = useAgentTasks.getState().subscribe(task.workspace_id);
    await vi.waitFor(() => expect(useAgentTasks.getState().approvals.decision).toBeDefined());
    const ch = created.at(-1)!;
    ch.status!("CHANNEL_ERROR");
    expect(useAgentTasks.getState().status).toBe("error");
    task = { ...task, state: "ready_for_review", waiting_on: "" };
    approvals = [];
    ch.status!("SUBSCRIBED");
    await vi.waitFor(() => expect(useAgentTasks.getState().status).toBe("ready"));
    const s = useAgentTasks.getState();
    expect(s.tasks[task.id].state).toBe("ready_for_review");
    expect(s.approvals.decision).toBeUndefined();
    expect(buildDecisionsHome({ tasks: Object.values(s.tasks), approvals: Object.values(s.approvals),
      runs: s.runs, agents: [], userId: task.owner_user_id, now: Date.now() }).waiting).toHaveLength(0);
    release();
  });

  it("ignores older loads and old callbacks even after switching back to a workspace", async () => {
    let finish!: (result: ReadResult) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const releaseA = useAgentTasks.getState().subscribe("a");
    const releaseSharedA = useAgentTasks.getState().subscribe("a");
    const old = created.at(-1)!;
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const releaseB = useAgentTasks.getState().subscribe("b");
    const releaseNewA = useAgentTasks.getState().subscribe("a");
    await vi.waitFor(() => expect(useAgentTasks.getState().status).toBe("ready"));
    old.handlers.get("agent_tasks")!({ new: { id: "old-event" } });
    old.status!("CHANNEL_ERROR");
    finish({ data: [{ ...(mockCard("1") as TaskCardData).task, id: "old-read" }], error: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAgentTasks.getState().tasks).toEqual({});
    expect(useAgentTasks.getState().status).toBe("ready");
    releaseA(); releaseSharedA(); releaseB();
    expect(removed).toHaveLength(2);
    releaseNewA();
    expect(removed).toHaveLength(3);
  });

  it.each([false, true])("does not let an older load replace a newer snapshot (failure: %s)", async (fails) => {
    await useAgentTasks.getState().load("overlap");
    let finish!: (result: ReadResult) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const older = useAgentTasks.getState().load("overlap");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const task = { ...(mockCard("1") as TaskCardData).task, id: "latest", state: "working" };
    read.mockImplementationOnce(async () => ({ data: [task], error: null }));
    await useAgentTasks.getState().load("overlap");
    finish({ data: [], error: fails ? { message: "old failure" } : null });
    await older;
    expect(useAgentTasks.getState().tasks.latest.state).toBe("working");
    expect(useAgentTasks.getState().status).toBe("ready");
  });

  it("keeps realtime updates and deletions received during a snapshot refresh", async () => {
    const release = useAgentTasks.getState().subscribe("events");
    await vi.waitFor(() => expect(useAgentTasks.getState().status).toBe("ready"));
    let finish!: (result: ReadResult) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useAgentTasks.getState().load("events");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const onTask = created.at(-1)!.handlers.get("agent_tasks")!;
    const task = { ...(mockCard("1") as TaskCardData).task, id: "task", state: "done" };
    onTask({ new: task });
    onTask({ eventType: "DELETE", new: {}, old: { id: "deleted" } });
    finish({ data: [{ ...task, state: "working" }, { ...task, id: "deleted", state: "working" }], error: null });
    await pending;
    expect(useAgentTasks.getState().tasks.task.state).toBe("done");
    expect(useAgentTasks.getState().tasks.deleted).toBeUndefined();
    release();
  });

  it("discards stale per-task reads, briefs and activities on a workspace switch", async () => {
    await useAgentTasks.getState().load("detail-a");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    read.mockImplementation(async () => { await gate; return { data: [{ id: "stale", task_id: "stale", version: 1 }], error: null }; });
    const pending = Promise.all([useAgentTasks.getState().loadTask("stale"),
      useAgentTasks.getState().loadTaskDetail("stale"), useAgentTasks.getState().loadActivities("stale")]);
    await vi.waitFor(() => expect(read.mock.calls.some(([table]) => table === "task_briefs")).toBe(true));
    read.mockResolvedValue({ data: [], error: null });
    await useAgentTasks.getState().load("detail-b");
    finish(); await pending;
    const s = useAgentTasks.getState();
    expect([s.tasks, s.runs, s.approvals, s.artifacts, s.reviews, s.briefs, s.activities, s.environments]).toEqual(Array.from({ length: 8 }, () => ({})));
  });

  it("does not let an older evidence read overwrite a newer commit's result", async () => {
    const data = mockCard("1") as TaskCardData;
    useAgentTasks.setState({ workspaceId: "race-ws", tasks: { [data.task.id]: data.task },
      briefs: { [`${data.task.id}:${data.task.brief_version}`]: { ...data.brief!, done_when: [{ id: "ci", text: "CI", check: "ci", command: "check" }] } } });
    let finishOlder!: (value: unknown) => void;
    client.rpc.mockImplementationOnce(() => new Promise((resolve) => { finishOlder = resolve; }));
    const older = useAgentTasks.getState().loadTaskDetail(data.task.id);
    await vi.waitFor(() => expect(finishOlder).toBeTypeOf("function"));
    const checks = [{ criterion_id: "ci", check: "check", state: "failed" }];
    client.rpc.mockResolvedValueOnce({ data: checks, error: null });
    await useAgentTasks.getState().loadTaskDetail(data.task.id);
    finishOlder({ data: [{ ...checks[0], state: "passed" }], error: null });
    await older;
    expect(useAgentTasks.getState().ciChecks[data.task.id]).toEqual(checks);
    client.rpc.mockClear();
    await useAgentTasks.getState().refreshCiChecks(data.task.workspace_id);
    expect(client.rpc).toHaveBeenCalledWith("task_ci_status", { p_task_id: data.task.id });
  });
  it("loads CI only when requested by the brief and refreshes on CI activity", async () => {
    const release = useAgentTasks.getState().subscribe("ci-ws");
    await vi.waitFor(() => expect(useAgentTasks.getState().status).toBe("ready"));
    const data = mockCard("1") as TaskCardData;
    const key = `${data.task.id}:${data.task.brief_version}`;
    useAgentTasks.setState({ tasks: { [data.task.id]: data.task }, briefs: { [key]: data.brief! } });
    client.rpc.mockClear();
    await useAgentTasks.getState().loadTaskDetail(data.task.id);
    expect(client.rpc).not.toHaveBeenCalled();
    useAgentTasks.setState({ briefs: { [key]: { ...data.brief!, done_when: [{ id: "ci", text: "CI", check: "ci", command: "check" }] } } });
    const checks = [{ criterion_id: "ci", check: "check", state: "passed" }];
    client.rpc.mockResolvedValue({ data: checks, error: null });
    await useAgentTasks.getState().loadTaskDetail(data.task.id);
    expect(client.rpc).toHaveBeenCalledWith("task_ci_status", { p_task_id: data.task.id });
    expect(useAgentTasks.getState().ciChecks[data.task.id]).toEqual(checks);
    client.rpc.mockClear();
    created.at(-1)!.handlers.get("agent_activities")!({ new: { id: "ci-event", task_id: data.task.id, body: { ci: { conclusion: "failure" } } } });
    await vi.waitFor(() => expect(client.rpc).toHaveBeenCalledWith("task_ci_status", { p_task_id: data.task.id }));
    client.rpc.mockClear();
    created.at(-1)!.handlers.get("agent_artifacts")!({ new: { id: "new-commit", task_id: data.task.id, kind: "diff", ref: "acme/app@new" } });
    expect(useAgentTasks.getState().ciChecks[data.task.id]).toEqual([]);
    await vi.waitFor(() => expect(client.rpc).toHaveBeenCalledWith("task_ci_status", { p_task_id: data.task.id }));
    release();
  });
  it("shares one channel per workspace and closes it with the last release", () => {
    const { subscribe } = useAgentTasks.getState();
    const releaseA = subscribe("ws-1");
    const releaseB = subscribe("ws-1");
    expect(created.map((c) => c.topic)).toEqual(["realtime:agents-ws-1"]);
    releaseA();
    releaseA(); // releasing twice is harmless
    expect(removed).toHaveLength(0);
    releaseB();
    expect(removed.map((c) => c.topic)).toEqual(["realtime:agents-ws-1"]);
  });

  it("replaces the channel when the workspace changes", () => {
    const { subscribe } = useAgentTasks.getState();
    const release1 = subscribe("ws-1");
    const release2 = subscribe("ws-2");
    expect(created.map((c) => c.topic)).toEqual(["realtime:agents-ws-1", "realtime:agents-ws-2"]);
    expect(removed.map((c) => c.topic)).toEqual(["realtime:agents-ws-1"]);
    release1(); // stale release does not touch the new channel
    expect(removed).toHaveLength(1);
    release2();
    expect(removed.map((c) => c.topic)).toEqual(["realtime:agents-ws-1", "realtime:agents-ws-2"]);
  });

  it("does not reuse a subscribed channel that removeChannel has not dropped yet", () => {
    const { subscribe } = useAgentTasks.getState();
    subscribe("ws-1")();
    expect(() => subscribe("ws-1")).not.toThrow(); // React strict mode: release then subscribe again at once
    expect(created).toHaveLength(2);
    subscribe("ws-2")();
  });
});

describe("useAgentNotifications.subscribe", () => {
  it("shares one inbox channel per user and survives an immediate resubscribe", () => {
    const { subscribe } = useAgentNotifications.getState();
    const releaseA = subscribe("user-1");
    const releaseB = subscribe("user-1");
    expect(created.map((c) => c.topic)).toEqual(["realtime:agent-inbox-user-1"]);
    releaseA();
    releaseB();
    expect(removed).toHaveLength(1);
    expect(() => subscribe("user-1")).not.toThrow();
    expect(created).toHaveLength(2);
  });
});
