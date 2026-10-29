import { describe, expect, it } from "vitest";
import { createBridge, resolveConfig, type BridgeConfig } from "../../bridge/index.mjs";
import { createChannel, eventToChannel, sanitizeMeta, type ChannelEvent } from "../../bridge/channel.mjs";

const MCP_URL = "https://ws.test/functions/v1/mcp";
const TOKEN_URL = "https://ws.test/functions/v1/agent-token";
const AGENT = "11111111-1111-1111-1111-111111111111";

/** A JSON-RPC message as seen by the tests. */
type Msg = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { protocolVersion?: string; [key: string]: unknown };
  result?: {
    ok?: boolean;
    protocolVersion?: string;
    capabilities?: { experimental?: unknown };
    serverInfo?: { name: string };
    instructions?: string;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
};
type Call = { url: string; headers: Record<string, string>; body: Msg };

/** Fake fetch: token endpoint hands out jwt-1, jwt-2…; the MCP endpoint answers via `onMcp`. */
function fakeFetch(onMcp: (body: Msg, headers: Record<string, string>) => Response | undefined) {
  const calls: Call[] = [];
  let exchanges = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, headers, body });
    if (url === TOKEN_URL) {
      exchanges++;
      return Response.json({ access_token: `jwt-${exchanges}`, token_type: "Bearer", expires_in: 3600, agent_id: AGENT, workspace_id: "ws-1" });
    }
    if (body?.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: {} } }), {
        headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
      });
    }
    if (body?.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
    return onMcp(body, headers) ?? Response.json({ jsonrpc: "2.0", id: body.id, result: { ok: true } });
  }) as typeof fetch;
  return { impl, calls, mcpCalls: () => calls.filter((c) => c.url === MCP_URL && !["initialize", "notifications/initialized"].includes(String(c.body?.method))) };
}

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return { ...resolveConfig({ WORKSPACE_MCP_URL: MCP_URL, WORKSPACE_AGENT_PAT: "agt_secret" }, []), ...overrides };
}

function setup(onMcp: Parameters<typeof fakeFetch>[0], cfg: Partial<BridgeConfig> = {}) {
  const fetch = fakeFetch(onMcp);
  const out: Msg[] = [];
  const bridge = createBridge({ config: config(cfg), write: (line) => out.push(JSON.parse(line)), fetch: fetch.impl, realtimeFactory: null });
  return { bridge, out, fetch };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

describe("bridge proxy", () => {
  it("derives the token URL from the MCP URL", () => {
    expect(config().tokenUrl).toBe(TOKEN_URL);
  });

  it("reads the Supabase URL and key for Realtime from WORKSPACE_SUPABASE_*", () => {
    const cfg = resolveConfig({ WORKSPACE_MCP_URL: MCP_URL, WORKSPACE_AGENT_PAT: "agt_secret", WORKSPACE_SUPABASE_URL: " https://ws.test ", WORKSPACE_SUPABASE_KEY: "sb_publishable_1 " }, []);
    expect(cfg.supabaseUrl).toBe("https://ws.test");
    expect(cfg.supabaseKey).toBe("sb_publishable_1");
  });

  it("ignores the old NEXT_PUBLIC_* names", () => {
    const cfg = resolveConfig({ WORKSPACE_MCP_URL: MCP_URL, NEXT_PUBLIC_SUPABASE_URL: "https://old.test", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k1", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k2" }, []);
    expect(cfg.supabaseUrl).toBe("");
    expect(cfg.supabaseKey).toBe("");
  });

  it("exchanges the PAT at start and sends the JWT on tools/list", async () => {
    const { bridge, out, fetch } = setup(() => undefined);
    await bridge.start();
    expect(fetch.calls[0]).toMatchObject({ url: TOKEN_URL, body: { token: "agt_secret" } });
    await bridge.handleMessage(initialize);
    await bridge.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const [call] = fetch.mcpCalls();
    expect(call.body).toEqual({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(call.headers.Authorization).toBe("Bearer jwt-1");
    expect(call.headers["Mcp-Session-Id"]).toBe("session-1");
    expect(out.find((m) => m.id === 2)).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
  });

  it("on 401 exchanges once more and retries once", async () => {
    let first = true;
    const { bridge, out, fetch } = setup((body) => {
      if (body.method === "tools/list" && first) { first = false; return new Response("expired", { status: 401 }); }
      return undefined;
    });
    await bridge.start();
    await bridge.handleMessage(initialize);
    await bridge.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(fetch.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
    expect(fetch.mcpCalls().map((c) => c.headers.Authorization)).toEqual(["Bearer jwt-1", "Bearer jwt-2"]);
    expect(out.find((m) => m.id === 2)?.result).toEqual({ ok: true });
  });

  it("does not loop when the retry is also rejected", async () => {
    const { bridge, out, fetch } = setup((body) => (body.method === "tools/list" ? new Response("no", { status: 401 }) : undefined));
    await bridge.start();
    await bridge.handleMessage(initialize);
    await bridge.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(fetch.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
    expect(fetch.mcpCalls()).toHaveLength(2);
    expect(out.find((m) => m.id === 2)?.error?.code).toBe(-32603);
  });

  it("forwards Mcp-Protocol-Version and _meta unchanged and streams progress back", async () => {
    const { bridge, out, fetch } = setup((body) => {
      const sse = [
        { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p-7", progress: 30 } },
        { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "done" }] } },
      ].map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    });
    await bridge.start();
    await bridge.handleMessage(initialize);
    const request = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wait_for_task", arguments: { task_id: "t" }, _meta: { progressToken: "p-7" } } };
    await bridge.handleMessage(request);
    const [call] = fetch.mcpCalls();
    expect(call.body).toEqual(request);
    expect(call.headers["Mcp-Protocol-Version"]).toBe("2025-03-26");
    expect(out.map((m) => m.method ?? m.id)).toEqual([1, "notifications/progress", 3]);
  });

  it("initialize answers locally and declares claude/channel", async () => {
    const { bridge, out, fetch } = setup(() => undefined);
    await bridge.handleMessage(initialize);
    expect(out[0].result?.protocolVersion).toBe("2025-03-26");
    expect(out[0].result?.capabilities?.experimental).toEqual({ "claude/channel": {} });
    expect(out[0].result?.serverInfo?.name).toBe("colabora");
    expect(out[0].result?.instructions).toContain("get_task");
    expect(fetch.mcpCalls()).toHaveLength(0);
  });

  it("--no-channel does not declare the channel", async () => {
    const { bridge, out } = setup(() => undefined, { noChannel: true });
    await bridge.handleMessage({ ...initialize, params: {} });
    expect(out[0].result?.protocolVersion).toBe("2025-06-18");
    expect(out[0].result?.capabilities?.experimental).toBeUndefined();
  });
});

describe("channel events", () => {
  it("maps a handover continue to the handover reason", () => {
    const event = eventToChannel({ type: "task.continue", task_id: "t1", payload: { handover: true } });
    expect(event.meta.reason).toBe("handover");
  });
  it("turns an agent event into a one-line channel event with valid meta keys", () => {
    const event = eventToChannel({
      type: "task.continue",
      task_id: "parent-1",
      agent_id: AGENT,
      run_id: null,
      event_id: "e-1",
      payload: { review_of: "sub-15", summary: "Delivered v2\nwith three\tactivities", "bad-key": "x" },
    });
    expect(event.content).toBe('sub-15 ready_for_review: untrusted text: "Delivered v2 with three activities"');
    expect(event.content).not.toMatch(/\n/);
    expect(event.meta).toEqual({ task_id: "sub-15", parent_task_id: "parent-1", reason: "ready_for_review", event_id: "e-1" });
    for (const key of Object.keys(event.meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it("maps task.updated to the updated reason", () => {
    const event = eventToChannel({ type: "task.updated", task_id: "parent-1", agent_id: AGENT, run_id: null, event_id: "e-2", payload: { subtask_id: "sub-9", acceptance: "accepted" } });
    expect(event.meta.reason).toBe("updated");
    expect(event.meta.task_id).toBe("parent-1");
  });

  it("drops meta keys with other characters and non-string values", () => {
    expect(sanitizeMeta({ ok_1: "a", "bad-key": "b", "has space": "c", n: 2, obj: { a: 1 }, empty: "" })).toEqual({ ok_1: "a", n: "2" });
  });

  it("ignores events of another agent", async () => {
    const emitted: ChannelEvent[] = [];
    let handler: (change: { new: unknown }) => void = () => {};
    const realtime = {
      channel: () => ({
        on(_type: string, _filter: unknown, cb: (change: { new: unknown }) => void) { handler = cb; return this; },
        subscribe(cb: (status: string) => void) { cb("SUBSCRIBED"); return this; },
      }),
    };
    const channel = createChannel({
      agentId: AGENT, supabaseUrl: "https://ws.test", jwt: "jwt-1",
      remote: { callTool: async () => { throw new Error("must not poll"); } },
      emit: (e) => emitted.push(e), realtimeFactory: () => realtime,
    });
    await channel.start();
    expect(channel.mode).toBe("realtime");
    handler({ new: { type: "task.feedback", task_id: "t-9", agent_id: "someone-else", payload: {} } });
    handler({ new: { type: "task.feedback", task_id: "t-1", agent_id: AGENT, event_id: "e-2", payload: {} } });
    handler({ new: { type: "task.feedback", task_id: "t-1", agent_id: AGENT, event_id: "e-2", payload: {} } });
    expect(emitted).toEqual([{ content: "t-1 feedback", meta: { task_id: "t-1", reason: "feedback", event_id: "e-2" } }]);
    channel.stop();
  });

  it("falls back to wait_for_my_tasks with the cursor when Realtime fails", async () => {
    const emitted: ChannelEvent[] = [];
    const calls: Record<string, unknown>[] = [];
    let channel: ReturnType<typeof createChannel>;
    const done = new Promise<void>((resolve) => {
      channel = createChannel({
        agentId: AGENT, supabaseUrl: "https://ws.test", jwt: "jwt-1",
        remote: {
          callTool: async (name, args) => {
            expect(name).toBe("wait_for_my_tasks");
            calls.push(args);
            if (calls.length === 1) return { changed: true, tasks: [{ task_id: "t-1", title: "Clean leads", state: "queued", reason: "feedback" }], next_cursor: "c-1" };
            channel.stop();
            resolve();
            return { changed: false, tasks: [], next_cursor: "c-1" };
          },
        },
        emit: (e) => emitted.push(e),
        realtimeFactory: () => { throw new Error("realtime down"); },
      });
    });
    await channel!.start();
    await done;
    expect(calls).toEqual([{ timeout_s: 120 }, { timeout_s: 120, after: "c-1" }]);
    expect(emitted).toEqual([{ content: 't-1 "Clean leads" feedback, state queued', meta: { task_id: "t-1", reason: "feedback", state: "queued" } }]);
  });

  it("switches to wait_for_my_tasks when the Realtime channel errors after subscribing", async () => {
    let status: (s: string) => void = () => {};
    const calls: Record<string, unknown>[] = [];
    let channel: ReturnType<typeof createChannel>;
    const polled = new Promise<void>((resolve) => {
      channel = createChannel({
        agentId: AGENT, supabaseUrl: "https://ws.test", jwt: "jwt-1",
        remote: { callTool: async (_name, args) => { calls.push(args); channel.stop(); resolve(); return { changed: false, tasks: [], next_cursor: "c-0" }; } },
        emit: () => {},
        realtimeFactory: () => ({
          channel: () => ({
            on() { return this; },
            subscribe(cb: (s: string) => void) { status = cb; cb("SUBSCRIBED"); return this; },
          }),
        }),
      });
    });
    await channel!.start();
    expect(channel!.mode).toBe("realtime");
    status("CHANNEL_ERROR");
    await polled;
    expect(calls).toEqual([{ timeout_s: 120 }]);
  });
});
