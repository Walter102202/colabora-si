import { describe, expect, it } from "vitest";
import { runAgent, type Clock } from "../../agent/loop.mjs";
import { McpError, type McpClient, type ToolResult } from "../../agent/mcpClient.mjs";
import { createStubModel, toolCall } from "../../agent/test/stub-model.mjs";
import { CLAUDE_CODE, createStubWorld } from "../../agent/test/stub-world.mjs";

function fakeClock(slept: number[] = []): Clock {
  let t = 0;
  return { now: () => t, sleep: async (ms) => {
    slept.push(ms);
    t += ms;
    if (t > 60_000) throw new Error("The runtime kept polling without handling the available task");
  } };
}

/** The world's client, with the first `times` calls of `tool` answered by `fault` (which may still forward the call). */
function faulty(client: McpClient, tool: string, times: number, fault: (forward: () => Promise<ToolResult>, nth: number) => Promise<ToolResult>) {
  let left = times;
  const seen: Record<string, unknown>[] = [];
  const wrapped: McpClient = {
    initialize: () => client.initialize(),
    listTools: () => client.listTools(),
    callTool: (name, args) => {
      if (name !== tool) return client.callTool(name, args);
      seen.push(structuredClone(args));
      return left-- > 0 ? fault(() => client.callTool(name, args), times - left - 1) : client.callTool(name, args);
    },
  };
  return { client: wrapped, seen };
}

const timeout: ToolResult = { isError: true, data: { code: "timeout", message: "The operation took too long. Retry, or narrow the request." }, text: "Error timeout" };
const conflict: ToolResult = { isError: true, data: { code: "conflict", message: "The record already exists." }, text: "Error conflict" };
const toolMessages = (request: { messages: { role: string; content?: unknown }[] } | undefined) =>
  (request?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));

function started(title: string) {
  const world = createStubWorld();
  const task = world.human.createTask({ title, delegate: CLAUDE_CODE });
  return { world, task, page: String(world.task(task).row_page_id) };
}
const lastCheckpoint = (world: ReturnType<typeof createStubWorld>) =>
  world.calls(CLAUDE_CODE).filter((c) => c.name === "save_checkpoint").at(-1)?.args.checkpoint as { ops: Record<"confirmed" | "pending", { key: string }[]> };
const pendingKeys = (world: ReturnType<typeof createStubWorld>) => lastCheckpoint(world).ops.pending.map((o) => o.key);

describe("agent loop: calls that fail on the way", () => {
  it("a write the server refuses before running it shows the model the validation message and is not retried", async () => {
    const { world, page } = started("Invalid");
    const message = "MCP tools/call error: Invalid arguments for append_blocks: $.after_block_id: expected string";
    const mcp = faulty(world.client(CLAUDE_CODE), "append_blocks", 1, async () => { throw new McpError(message, -32602); });
    const model = createStubModel([
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "One", after_block_id: 5 })] },
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "One" })] },
    ]);
    await runAgent({ mcp: mcp.client, model, clock: fakeClock(), maxTasks: 1, harness: "claude_code" });
    expect(mcp.seen).toHaveLength(2);
    const [refused] = toolMessages(model.requests[1]);
    expect(refused).toContain("expected string");
    expect(refused).not.toContain("may have happened");
    expect(pendingKeys(world)).toEqual([mcp.seen[1].idempotency_key]);
    expect(world.blocks(page)).toHaveLength(1);
  });

  it("a write whose response timed out is retried once with the same key and lands once", async () => {
    const { world, page } = started("Timeout");
    const mcp = faulty(world.client(CLAUDE_CODE), "append_blocks", 1, async (forward) => { await forward(); return timeout; });
    const model = createStubModel([{ tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Once" })] }]);
    await runAgent({ mcp: mcp.client, model, clock: fakeClock(), maxTasks: 1, harness: "claude_code" });
    expect(mcp.seen.map((a) => a.idempotency_key)).toEqual([mcp.seen[0].idempotency_key, mcp.seen[0].idempotency_key]);
    expect(world.blocks(page)).toHaveLength(1);
    expect(toolMessages(model.requests.at(-1)).join("\n")).not.toContain("error");
  });

  it("a write that timed out twice is reported as maybe done and stays pending in the checkpoint", async () => {
    const { world, page } = started("Timeout twice");
    const mcp = faulty(world.client(CLAUDE_CODE), "append_blocks", 2, async (forward) => { await forward(); return timeout; });
    const model = createStubModel([
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "One" })] },
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Two" })] },
    ]);
    await runAgent({ mcp: mcp.client, model, clock: fakeClock(), maxTasks: 1, harness: "claude_code" });
    expect(JSON.parse(toolMessages(model.requests[1])[0])).toMatchObject({ error: "timeout", outcome: "unknown" });
    expect(pendingKeys(world)).toEqual([mcp.seen[0].idempotency_key, mcp.seen[2].idempotency_key]);
    expect(world.blocks(page).map((b) => b.text)).toEqual(["One", "Two"]);
  });

  it("a retry that collides with the receipt of a first call still committing reads the receipt a second later", async () => {
    const { world, page } = started("Still committing");
    // The first call times out before its transaction commits; the retry waits for it and hits its receipt (conflict).
    const answers = [async () => timeout, async (forward: () => Promise<ToolResult>) => { await forward(); return conflict; }];
    const mcp = faulty(world.client(CLAUDE_CODE), "append_blocks", 2, (forward, nth) => answers[nth](forward));
    const slept: number[] = [];
    const model = createStubModel([
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "One" })] },
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Two" })] },
    ]);
    await runAgent({ mcp: mcp.client, model, clock: fakeClock(slept), maxTasks: 1, harness: "claude_code" });
    const first = mcp.seen[0].idempotency_key;
    expect(mcp.seen.slice(0, 3).map((a) => a.idempotency_key)).toEqual([first, first, first]);
    expect(slept).toEqual([1000]);
    expect(toolMessages(model.requests[1]).join("\n")).not.toContain("error");
    expect(lastCheckpoint(world).ops.confirmed.map((o) => o.key)).toEqual([first]);
    expect(world.blocks(page).map((b) => b.text)).toEqual(["One", "Two"]);
  });

  it("a retry after a timeout that fails for another reason still reports the write as maybe done", async () => {
    const { world, page } = started("Timeout then refused");
    const rateLimited: ToolResult = { isError: true, data: { code: "rate_limited", message: "Too many calls." }, text: "Error rate_limited" };
    // The first call may still land after its timeout; the retry is refused before it runs, so it proves nothing.
    const answers = [async (forward: () => Promise<ToolResult>) => { await forward(); return timeout; }, async () => rateLimited];
    const mcp = faulty(world.client(CLAUDE_CODE), "append_blocks", 2, (forward, nth) => answers[nth](forward));
    const model = createStubModel([
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "One" })] },
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Two" })] },
    ]);
    await runAgent({ mcp: mcp.client, model, clock: fakeClock(), maxTasks: 1, harness: "claude_code" });
    expect(JSON.parse(toolMessages(model.requests[1])[0])).toMatchObject({ error: "rate_limited", outcome: "unknown" });
    expect(pendingKeys(world)).toContain(mcp.seen[0].idempotency_key);
    expect(world.blocks(page).map((b) => b.text)).toEqual(["One", "Two"]);
  });

  it("hand_over whose response is lost is retried once with the same key instead of ending the run", async () => {
    const { world, task, page } = started("Close");
    const close = new AbortController();
    world.script(CLAUDE_CODE, "append_blocks", 1, () => close.abort());
    world.faults.loseResponses(CLAUDE_CODE, "hand_over", { count: 1 });
    const model = createStubModel([{ tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "One" })] }]);
    const out = await runAgent({ mcp: world.client(CLAUDE_CODE), model, clock: fakeClock(), maxTasks: 1, harness: "claude_code", signal: close.signal });
    expect(out.tasks[0].outcome).toBe("aborted");
    const handOvers = world.calls(CLAUDE_CODE).filter((c) => c.name === "hand_over");
    expect(handOvers.map((c) => c.outcome)).toEqual(["lost", "ok"]);
    expect(handOvers[1].args.idempotency_key).toBe(handOvers[0].args.idempotency_key);
    expect(world.calls(CLAUDE_CODE).some((c) => c.name === "end_run")).toBe(false);
    expect(world.task(task).state).toBe("queued");
  });

  it("hand_over refused by a person's stop acknowledges the stop instead of ending the run with an error", async () => {
    const { world, task, page } = started("Stop");
    const close = new AbortController();
    world.script(CLAUDE_CODE, "append_blocks", 1, () => { world.human.stop(task); close.abort(); });
    const model = createStubModel([{ tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "One" })] }]);
    await runAgent({ mcp: world.client(CLAUDE_CODE), model, clock: fakeClock(), maxTasks: 1, harness: "claude_code", signal: close.signal });
    const calls = world.calls(CLAUDE_CODE);
    expect(calls.filter((c) => c.name === "hand_over").map((c) => c.outcome)).toEqual(["error:stop_requested"]);
    expect(calls.map((c) => c.name)).toContain("ack_stop");
    expect(calls.some((c) => c.name === "end_run")).toBe(false);
    expect(world.task(task).state).toBe("cancelled");
  });
});
