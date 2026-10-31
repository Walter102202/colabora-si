import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { codexQueue, findCodex, runWatcher, SESSION_HINT, targetThread } from "../../connect/codex/watch.mjs";

const THREAD = "11111111-1111-4111-8111-111111111111";
const FALLBACK = "22222222-2222-4222-8222-222222222222";
const ENV = { WORKSPACE_MCP_URL: "https://local.test/functions/v1/mcp", WORKSPACE_AGENT_PAT: "test-pat" };
const task = (extra: Record<string, unknown> = {}) => ({ task_id: "task-1", state: "queued", reason: "feedback", session_id: THREAD, brief_version: 1, pending_prompts: 1, ...extra });
type Answer = { tasks: Record<string, unknown>[]; next_cursor: string };
const answer = (tasks: Record<string, unknown>[], next_cursor = "next"): Answer => ({ tasks, next_cursor });

async function exercise(waits: Answer[], options: {
  env?: Record<string, string | undefined>; cursor?: string; detail?: unknown; details?: unknown[];
  queue?: (thread: string, message: string) => Promise<void>;
} = {}) {
  const controller = new AbortController();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const saves: { cursor: string }[] = [];
  const logs: string[] = [];
  let index = 0;
  let detailIndex = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/agent-token")) return Response.json({ access_token: "test-jwt", expires_in: 3600 });
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    const { name, arguments: args } = body.params;
    calls.push({ name, args });
    let result: unknown = options.detail ?? { activities: [] };
    if (name === "get_task" && options.details) result = options.details[Math.min(detailIndex++, options.details.length - 1)];
    if (name === "wait_for_my_tasks") {
      result = waits[index++];
      if (index >= waits.length) controller.abort();
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }], structuredContent: result } });
  });
  const queue = vi.fn(options.queue ?? (async () => {}));
  await runWatcher({ env: options.env ?? ENV, queue, state: { load: () => ({ cursor: options.cursor }), save: (s) => saves.push(s) },
    fetchImpl: fetchImpl as typeof fetch, signal: controller.signal, sleep: async () => {}, log: (line) => logs.push(line) });
  return { calls, queue, saves, logs, fetchImpl };
}

describe("Codex watcher", () => {
  it("queues clean feedback to its saved session with the session hint", async () => {
    const result = await exercise([answer([task()])], { detail: { activities: [{ seq: 2, type: "prompt", body: { signal: "feedback", text: 'Fix <tag> "quoted" `code`' } }] } });
    expect(result.queue).toHaveBeenCalledTimes(1);
    const [thread, message] = result.queue.mock.calls[0];
    expect(thread).toBe(THREAD);
    expect(message).toContain("<<<Fix tag quoted code>>>");
    expect(message.endsWith(SESSION_HINT)).toBe(true);
  });
  it("logs a task with no session and uses only an explicit fallback", async () => {
    const missing = await exercise([answer([task({ session_id: null })])]);
    expect(missing.queue).not.toHaveBeenCalled(); expect(missing.logs.join()).toContain("task-1");
    const fallback = await exercise([answer([task({ session_id: null })])], { env: { ...ENV, WORKSPACE_CODEX_THREAD: FALLBACK } });
    expect(fallback.queue.mock.calls[0][0]).toBe(FALLBACK);
  });
  it.each(["--help", "x; rm -rf"])("never uses a malformed session or replaces it by the fallback: %s", async (session_id) => {
    const result = await exercise([answer([task({ session_id })])], { env: { ...ENV, WORKSPACE_CODEX_THREAD: FALLBACK } });
    expect(result.queue).not.toHaveBeenCalled(); expect(targetThread({ session_id }, FALLBACK)).toBeNull();
  });
  it("delivers a repeated task and reason once", async () => {
    expect((await exercise([answer([task()], "one"), answer([task()], "two")])).queue).toHaveBeenCalledTimes(1);
  });
  it("deduplicates snapshot/cursor copies by the prompt, and delivers a later feedback round", async () => {
    const detail = (seq: number) => ({ activities: [{ seq, type: "prompt", body: { signal: "feedback", text: seq === 2 ? "Initial finding" : "New finding" } }] });
    const result = await exercise([
      answer([task({ pending_prompts: 0 })], "initial"),
      answer([task({ pending_prompts: 1 })], "repeat"),
      answer([task({ pending_prompts: 1 })], "new-round"),
    ], { details: [detail(2), detail(2), detail(8)] });
    expect(result.queue).toHaveBeenCalledTimes(2);
    expect(result.queue.mock.calls[1][1]).toContain("New finding");
    expect(result.calls.filter((c) => c.name === "get_task")).toHaveLength(3);
  });
  it.each([
    { reason: "stop" }, { reason: "approval_decided" }, { reason: null },
    { state: "done" }, { state: "cancelled" }, { state: "failed" }, { waiting_on: "human" },
  ])("does not wake for a non-actionable task: %j", async (overrides) => {
    expect((await exercise([answer([task(overrides)])])).queue).not.toHaveBeenCalled();
  });
  it("allows an explicit handover while waiting on a person", async () => {
    expect((await exercise([answer([task({ reason: "handover", waiting_on: "human" })])])).queue).toHaveBeenCalledTimes(1);
  });
  it("does not advance on queue failure, retries, and restores the persisted cursor", async () => {
    let attempts = 0;
    const result = await exercise([answer([task()], "delivered"), answer([task()], "delivered"), answer([], "end")], {
      cursor: "saved", queue: async () => { if (++attempts === 1) throw new Error("queue unavailable"); },
    });
    expect(result.queue).toHaveBeenCalledTimes(2);
    expect(result.logs.join()).toContain("queue unavailable");
    expect(result.calls.filter((c) => c.name === "wait_for_my_tasks").map((c) => c.args.after)).toEqual(["saved", "saved", "delivered"]);
    expect(result.saves).toEqual([{ cursor: "delivered" }, { cursor: "end" }]);
    const restarted = await exercise([answer([])], { cursor: result.saves.at(-1)!.cursor });
    expect(restarted.calls[0].args.after).toBe("end");
  });
  it.each([{}, { WORKSPACE_MCP_URL: ENV.WORKSPACE_MCP_URL }])("stops without credentials: %j", async (env) => {
    const result = await exercise([], { env });
    expect(result.fetchImpl).not.toHaveBeenCalled(); expect(result.queue).not.toHaveBeenCalled(); expect(result.logs.length).toBe(1);
  });
  it("finds an explicit CLI, the newest Desktop build, or PATH", () => {
    const base = join("C:/local", "OpenAI", "Codex", "bin");
    const newest = join(base, "new", "codex.exe");
    const fs = { existsSync: () => true, readdirSync: () => ["old", "new"], statSync: (path: string) => ({ mtimeMs: path === newest ? 2 : 1 }) };
    expect(findCodex({ WORKSPACE_CODEX_BIN: "explicit" }, fs)).toBe("explicit");
    expect(findCodex({ LOCALAPPDATA: "C:/local" }, fs)).toBe(newest);
    expect(findCodex({}, fs)).toBe("codex");
    expect(findCodex({ LOCALAPPDATA: "C:/local" }, { ...fs, existsSync: () => false })).toBe("codex");
  });
  it("queues through execFile with separate arguments and a hidden window", async () => {
    const run = vi.fn((_file: string, _args: string[], _options: object, done: (error: Error | null) => void) => done(null));
    await codexQueue("codex.exe", run)(THREAD, 'message "with" ; shell text');
    expect(run).toHaveBeenCalledExactlyOnceWith("codex.exe", ["queue", "--thread", THREAD, "--message", 'message "with" ; shell text'],
      { timeout: 60_000, windowsHide: true }, expect.any(Function));
  });
});
