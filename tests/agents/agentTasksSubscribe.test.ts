import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";

// Many cells and one row panel subscribe to the same workspace: they must share
// one realtime channel, which closes only when the last subscriber releases.
// The fake client mirrors supabase-js: `channel(topic)` hands back the channel
// registered under that topic until `removeChannel` has run, and a subscribed
// channel refuses new `on` callbacks.
type ChangeHandler = (payload: { new: Record<string, unknown> }) => void;
type Chan = { topic: string; subscribed: boolean; handlers: Map<string, ChangeHandler>; on(event?: string, filter?: { table: string }, callback?: ChangeHandler): Chan; subscribe(): Chan };
const registry = new Map<string, Chan>();
const created: Chan[] = [];
const removed: Chan[] = [];
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
      subscribe() { ch.subscribed = true; return ch; },
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
  from() {
    const chain: Record<string, unknown> = {};
    const resolved = Promise.resolve({ data: [], error: null });
    for (const m of ["select", "eq", "neq", "in", "gt", "lt", "or", "order", "limit", "is"]) chain[m] = () => chain;
    chain.then = resolved.then.bind(resolved);
    return chain as { select: () => typeof chain };
  },
};
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => client, agentErrorMessage: (e: unknown) => String(e) }));

const { useAgentTasks } = await import("@/lib/agentTasks");
const { useAgentNotifications } = await import("@/lib/agentNotifications");

beforeEach(() => { registry.clear(); created.length = 0; removed.length = 0; client.rpc.mockReset().mockResolvedValue({ data: [], error: null }); });

describe("useAgentTasks.subscribe", () => {
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
