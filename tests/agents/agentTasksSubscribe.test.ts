import { beforeEach, describe, expect, it, vi } from "vitest";

// Many cells and one row panel subscribe to the same workspace: they must share
// one realtime channel, which closes only when the last subscriber releases.
// The fake client mirrors supabase-js: `channel(topic)` hands back the channel
// registered under that topic until `removeChannel` has run, and a subscribed
// channel refuses new `on` callbacks.
type Chan = { topic: string; subscribed: boolean; on(): Chan; subscribe(): Chan };
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
      on() {
        if (ch.subscribed) throw new Error(`cannot add callbacks for ${topic} after subscribe()`);
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
  from() { return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }), order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }; },
};
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => client, agentErrorMessage: (e: unknown) => String(e) }));

const { useAgentTasks } = await import("@/lib/agentTasks");
const { useAgentNotifications } = await import("@/lib/agentNotifications");

beforeEach(() => { registry.clear(); created.length = 0; removed.length = 0; });

describe("useAgentTasks.subscribe", () => {
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
