import { beforeEach, describe, expect, it, vi } from "vitest";

// Many cells and one row panel subscribe to the same workspace: they must share
// one realtime channel, which closes only when the last subscriber releases.
const channels: { topic: string }[] = [];
const removed: { topic: string }[] = [];
const client = {
  channel(topic: string) {
    const ch = { topic, on() { return ch; }, subscribe() { return ch; } };
    channels.push(ch);
    return ch;
  },
  removeChannel(ch: { topic: string }) { removed.push(ch); return Promise.resolve("ok"); },
  from() { return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }; },
};
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => client, agentErrorMessage: (e: unknown) => String(e) }));

const { useAgentTasks } = await import("@/lib/agentTasks");

describe("useAgentTasks.subscribe", () => {
  beforeEach(() => { channels.length = 0; removed.length = 0; });

  it("shares one channel per workspace and closes it with the last release", () => {
    const { subscribe } = useAgentTasks.getState();
    const releaseA = subscribe("ws-1");
    const releaseB = subscribe("ws-1");
    expect(channels.map((c) => c.topic)).toEqual(["agents-ws-1"]);
    releaseA();
    releaseA(); // releasing twice is harmless
    expect(removed).toHaveLength(0);
    releaseB();
    expect(removed.map((c) => c.topic)).toEqual(["agents-ws-1"]);
  });

  it("replaces the channel when the workspace changes", () => {
    const { subscribe } = useAgentTasks.getState();
    const release1 = subscribe("ws-1");
    const release2 = subscribe("ws-2");
    expect(channels.map((c) => c.topic)).toEqual(["agents-ws-1", "agents-ws-2"]);
    expect(removed.map((c) => c.topic)).toEqual(["agents-ws-1"]);
    release1(); // stale release does not touch the new channel
    expect(removed).toHaveLength(1);
    release2();
    expect(removed.map((c) => c.topic)).toEqual(["agents-ws-1", "agents-ws-2"]);
  });
});
