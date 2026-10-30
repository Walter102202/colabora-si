import { describe, expect, it } from "vitest";
import { MAX_REASON_CHARS, runStopHook } from "../../connect/codex/on-stop.mjs";

const MCP_URL = "https://ws.test/functions/v1/mcp";
const ENV = { WORKSPACE_MCP_URL: MCP_URL, WORKSPACE_AGENT_PAT: "agt_secret", HOOK_WAIT_MIN: "25" };
const TASK = "22222222-2222-2222-2222-222222222222";

type Tasks = { tasks: Record<string, unknown>[]; next_cursor: string };
type ToolCall = { name: string; args: Record<string, unknown> };

/** Fake remote: `waits` answers successive wait_for_my_tasks calls (the last one repeats). */
function fakeRemote(waits: Tasks[], detail: unknown = { activities: [] }) {
  const calls: ToolCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/agent-token")) return Response.json({ access_token: "jwt-1", expires_in: 3600, agent_id: "agent-1" });
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    if (body.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
    const { name, arguments: args } = body.params;
    calls.push({ name, args });
    let structuredContent: unknown = detail;
    if (name === "wait_for_my_tasks") {
      structuredContent = { changed: waits[Math.min(index, waits.length - 1)].tasks.length > 0, ...waits[Math.min(index, waits.length - 1)] };
      index++;
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }], structuredContent } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A clock that advances `stepMs` on every read. */
function clock(stepMs: number) {
  let t = 1_000_000;
  return () => (t += stepMs);
}

const sleep = async () => {};
const none: Tasks = { tasks: [], next_cursor: "c-0" };

describe("Codex stop hook", () => {
  it("continues the session on a handover with a resume instruction", async () => {
    const { fetchImpl } = fakeRemote([{ tasks: [{ task_id: TASK, state: "queued", reason: "handover" }], next_cursor: "c-1" }]);
    const result = await runStopHook({ input: {}, env: ENV, fetchImpl, now: clock(1000), sleep });
    const output = JSON.parse(result.output ?? "{}");
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("resume: true");
  });
  it("continues a handover that waits on a person: the new session claims it and waits in its run", async () => {
    const { fetchImpl } = fakeRemote([none, { tasks: [{ task_id: TASK, state: "input_required", waiting_on: "human", reason: "handover" }], next_cursor: "c-1" }]);
    const result = await runStopHook({ input: {}, env: ENV, fetchImpl, now: clock(1000), sleep });
    const output = JSON.parse(result.output ?? "{}");
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("resume: true");
    expect(output.reason).toContain("wait_for_task");
  });
  it("blocks with the task id and the findings when feedback is pending", async () => {
    const longNote = "Missing evidence for the deduplication criterion. ".repeat(200);
    const { fetchImpl, calls } = fakeRemote(
      [{ tasks: [{ task_id: TASK, title: "Clean leads", state: "queued", reason: "feedback" }], next_cursor: "c-1" }],
      { activities: [{ seq: 4, type: "prompt", body: { signal: "feedback", source: "lead", text: "Two findings.", findings: [{ criterion_id: "c1", status: "not_found", note: longNote }] } }] },
    );
    const result = await runStopHook({ input: { stop_hook_active: false }, env: ENV, fetchImpl, now: clock(1000), sleep });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.output ?? "{}");
    expect(output.decision).toBe("block");
    expect(output.reason).toContain(`claim_task("${TASK}")`);
    expect(output.reason).toContain("Two findings.");
    expect(output.reason).toContain("submit_for_review");
    expect(output.reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    expect(calls[0]).toEqual({ name: "wait_for_my_tasks", args: { timeout_s: 0 } });
    expect(calls[1]).toEqual({ name: "get_task", args: { task_id: TASK, activities_limit: 10 } });
  });

  it("waits with the cursor and continues only when a change arrives", async () => {
    const { fetchImpl, calls } = fakeRemote([
      none,
      none,
      { tasks: [{ task_id: TASK, state: "queued", reason: "queued" }], next_cursor: "c-2" },
    ]);
    const result = await runStopHook({ input: {}, env: ENV, fetchImpl, now: clock(1000), sleep });
    expect(JSON.parse(result.output ?? "{}").reason).toContain(`claim_task("${TASK}")`);
    expect(calls.map((c) => c.args.after)).toEqual([undefined, "c-0", "c-0"]);
    expect(calls.slice(1).every((c) => Number(c.args.timeout_s) <= 120)).toBe(true);
  });

  it("keeps waiting after a done task until the deadline", async () => {
    const { fetchImpl, calls } = fakeRemote([none, { tasks: [{ task_id: TASK, state: "done", reason: "feedback" }], next_cursor: "c-1" }]);
    expect(await runStopHook({ input: {}, env: ENV, fetchImpl, now: clock(60_000), sleep })).toEqual({ exitCode: 0 });
    expect(calls.length).toBeGreaterThan(2);
  });

  it.each([
    ["closed", "done"],
    ["stop", "cancelled"],
  ])("a %s task does not end the wait: the next queued task continues the session", async (reason, state) => {
    const { fetchImpl, calls } = fakeRemote([
      { tasks: [{ task_id: "t1", reason, state }], next_cursor: "c-1" },
      { tasks: [{ task_id: "t2", reason: "queued", state: "queued" }], next_cursor: "c-2" },
    ]);
    const result = await runStopHook({ input: {}, env: ENV, fetchImpl, now: clock(1000), sleep });
    const output = JSON.parse(result.output ?? "{}");
    expect(output.decision).toBe("block");
    expect(output.reason).toContain('claim_task("t2")');
    expect(calls[1].args.after).toBe("c-1");
  });

  it("keeps waiting while a review blocked the task, and continues when the person answers", async () => {
    // wait_for_my_tasks reports a blocked or escalated review as feedback that waits on a person: not work, no reason to stop.
    const blocked = { task_id: TASK, state: "input_required", waiting_on: "human", review_state: "none", reason: "feedback" };
    const answered = { task_id: TASK, state: "queued", waiting_on: null, review_state: "none", reason: "feedback" };
    const { fetchImpl, calls } = fakeRemote([{ tasks: [blocked], next_cursor: "c-1" }, none, { tasks: [answered], next_cursor: "c-2" }],
      { activities: [{ seq: 9, type: "prompt", body: { signal: "feedback", source: "row_panel", text: "Use fiscal year 2025." } }] });
    const result = await runStopHook({ input: {}, env: ENV, fetchImpl, now: clock(1000), sleep });
    const output = JSON.parse(result.output ?? "{}");
    expect(output.decision).toBe("block");
    expect(output.reason).toContain(`claim_task("${TASK}")`);
    expect(output.reason).toContain("Use fiscal year 2025.");
    expect(calls.map((c) => c.name)).toEqual(["wait_for_my_tasks", "wait_for_my_tasks", "wait_for_my_tasks", "get_task"]);
  });
  it("keeps waiting while an escalated task waits on a person, and exits 0 only at the limit", async () => {
    const escalated = { task_id: TASK, state: "input_required", waiting_on: "human", review_state: "changes_requested", reason: "feedback" };
    const { fetchImpl, calls } = fakeRemote([none, { tasks: [escalated], next_cursor: "c-1" }]);
    expect(await runStopHook({ input: {}, env: ENV, fetchImpl, now: clock(60_000), sleep })).toEqual({ exitCode: 0 });
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((c) => c.name === "wait_for_my_tasks")).toBe(true);
  });

  it("exits 0 when HOOK_WAIT_MIN passes with no news", async () => {
    const { fetchImpl, calls } = fakeRemote([none]);
    const result = await runStopHook({ input: {}, env: ENV, fetchImpl, now: clock(60_000), sleep });
    expect(result).toEqual({ exitCode: 0 });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(30);
  });

  it("with stop_hook_active and no news exits 0 instead of continuing on what was already pending", async () => {
    const pending = { tasks: [{ task_id: TASK, state: "queued", reason: "feedback" }], next_cursor: "c-1" };
    const { fetchImpl, calls } = fakeRemote([pending, { tasks: [], next_cursor: "c-1" }]);
    const result = await runStopHook({ input: { stop_hook_active: true }, env: ENV, fetchImpl, now: clock(5 * 60_000), sleep });
    expect(result).toEqual({ exitCode: 0 });
    expect(calls.every((c) => c.name === "wait_for_my_tasks")).toBe(true);
  });
  it.each(["queued", "handover"])("keeps an existing %s task in the first continuation snapshot", async (reason) => {
    const { fetchImpl } = fakeRemote([{ tasks: [{ task_id: "next-task", state: "queued", reason }], next_cursor: "c-1" }, none]);
    const result = await runStopHook({ input: { stop_hook_active: true }, env: ENV, fetchImpl, now: clock(5 * 60_000), sleep });
    const output = JSON.parse(result.output ?? "{}");
    expect(output.decision).toBe("block");
    expect(output.reason).toContain(reason === "handover" ? 'claim_task("next-task", resume: true)' : 'claim_task("next-task")');
  });

  it("never blocks without a real task change", async () => {
    const { fetchImpl } = fakeRemote([
      none,
      { tasks: [{ task_id: TASK, state: "working", reason: "approval_decided" }], next_cursor: "c-1" },
      { tasks: [], next_cursor: "c-1" },
    ]);
    const result = await runStopHook({ input: {}, env: ENV, fetchImpl, now: clock(5 * 60_000), sleep });
    expect(result.output).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("does nothing without a token", async () => {
    expect(await runStopHook({ input: {}, env: {}, sleep })).toEqual({ exitCode: 0 });
  });
});
