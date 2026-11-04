import { expect, it } from "vitest";
import { runAgent, type Clock } from "../../agent/loop.mjs";
import { createStubMcp } from "../../agent/test/stub-mcp.mjs";
import { createStubModel, toolCall, type ScriptStep } from "../../agent/test/stub-model.mjs";
import type { Model } from "../../agent/model.mjs";
const seed = () => ({ changed: false, stop_requested: false, activities: [], next_seq: 1, task: { task_id: "w1", state: "working", subtasks: [] } });
/** A clock whose sleep yields to the event loop, so a test can release a wait with setTimeout. */
function yieldingClock(): Clock { let t = 0; return { now: () => t, sleep: async (ms) => { await new Promise((r) => setTimeout(r, 0)); t += ms; } }; }
const until = (ok: () => boolean) => new Promise<void>((resolve, reject) => { const t0 = Date.now(); const tick = () => ok() ? resolve() : Date.now() - t0 > 4000 ? reject(new Error("until timed out")) : setTimeout(tick, 5); tick(); });
/** Scripts per kind: a fill request calls the model without tools, a work task with tools. */
function routedModel(scripts: { work: ScriptStep[]; request: ScriptStep[] }) {
  const work = createStubModel(scripts.work), request = createStubModel(scripts.request);
  return { name: "routed", requests: [] as object[], chat: (req: Parameters<Model["chat"]>[0]) => (req.tools ? work : request).chat(req), work, request };
}
const work = (id: string) => ({ task_id: id, title: id, state: "queued", reason: "queued", pending_prompts: 0 });
const fill = (id: string) => ({ ...work(id), request_kind: "fill" });
const fillHandlers = (opts: { onClaim?: () => void; onComplete?: () => void; delayMs?: number } = {}) => ({
  get_ai_request: () => ({ kind: "fill", property: { prompt: "Summarize" }, rows: [{ row_id: "r1", rev: 0, inputs: { Notes: "Text" } }] }),
  fill_ai_cells: async () => { await new Promise((r) => setTimeout(r, opts.delayMs ?? 0)); return { written: [{ row_id: "r1" }], conflicts: [], skipped: [] }; },
  complete_ai_request: () => { opts.onComplete?.(); return { task_state: "done" }; },
});
const askThenSubmit = [
  { tool_calls: [toolCall("request_input", { question: "Ready?", blocking: true })] },
  { tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: [] })] },
];
const answer = { changed: true, stop_requested: false, next_seq: 12, activities: [{ seq: 12, type: "prompt", author_type: "human", signal: "feedback", approval_id: "input-1", decision: "respond", text: "Go", excerpt: "Go" }] };
it("LN-1 answers a request while a work run waits for a person", async () => {
  let release!: () => void; const released = new Promise<void>((r) => { release = r; }); let waits = 0;
  const mcp = createStubMcp({ tasks: [work("w1"), fill("q1")], handlers: { ...fillHandlers(),
    wait_for_task: () => ++waits === 1 ? seed() : released.then(() => answer) } });
  const model = routedModel({ work: askThenSubmit, request: [{ content: '{"values":[{"row_id":"r1","text":"Short"}]}' }] });
  const run = runAgent({ mcp, model, clock: yieldingClock(), maxTasks: 2 });
  await until(() => mcp.calls.some((c) => c.name === "complete_ai_request"));
  expect(mcp.calls.some((c) => c.name === "submit_for_review")).toBe(false);   // el trabajo sigue esperando
  release();
  const { tasks } = await run;
  expect(tasks.map((t) => [t.task_id, t.outcome]).sort()).toEqual([["q1", "submitted"], ["w1", "submitted"]]);
});
it("LN-2 a second work task waits in the backlog and starts when the first ends", async () => {
  const mcp = createStubMcp({ tasks: [work("w1"), work("w2")], waits: [seed(), seed()] });
  const model = createStubModel([{ tool_calls: [toolCall("submit_for_review", { summary: "1", artifact_ids: [] })] }, { tool_calls: [toolCall("submit_for_review", { summary: "2", artifact_ids: [] })] }]);
  const { tasks } = await runAgent({ mcp, model, clock: yieldingClock(), maxTasks: 2 });
  const at = (pred: (c: { name: string; args: Record<string, any> }) => boolean) => mcp.calls.findIndex(pred);
  expect(at((c) => c.name === "claim_task" && c.args.task_id === "w2")).toBeGreaterThan(at((c) => c.name === "submit_for_review" && c.args.run_id === "run-w1"));
  expect(tasks.map((t) => t.task_id)).toEqual(["w1", "w2"]);
});
it("LN-5 an event for an active task does not open a second run", async () => {
  let release!: () => void; const released = new Promise<void>((r) => { release = r; }); let polls = 0, waits = 0;
  const abort = new AbortController();
  const mcp = createStubMcp({ handlers: {
    wait_for_my_tasks: () => ({ changed: polls < 2, tasks: ++polls === 1 ? [work("w1")] : polls === 2 ? [{ ...work("w1"), reason: "feedback" }] : [], next_cursor: `c${polls}` }),
    wait_for_task: () => ++waits === 1 ? seed() : released.then(() => answer) } });
  // maxTasks: 2 keeps the loop polling while w1 runs (one slot stays open); the abort ends the test once w1 delivered.
  const run = runAgent({ mcp, model: createStubModel(askThenSubmit), clock: yieldingClock(), maxTasks: 2, signal: abort.signal });
  await until(() => polls >= 3); release();
  await until(() => mcp.calls.some((c) => c.name === "submit_for_review")); abort.abort();
  const { tasks } = await run;
  expect(mcp.calls.filter((c) => c.name === "claim_task")).toHaveLength(1);
  expect(tasks.map((t) => [t.task_id, t.outcome])).toEqual([["w1", "submitted"]]);
});

const handOverTool = { name: "hand_over", description: "Hand the run over", inputSchema: { type: "object", properties: { run_id: { type: "string" }, idempotency_key: { type: "string" }, checkpoint: { type: "object" } }, required: ["run_id", "checkpoint"] } };
it("LN-3 runs at most maxRequestRuns requests at once and finishes all of them", async () => {
  let inFlight = 0, peak = 0;
  const mcp = createStubMcp({ tasks: ["q1", "q2", "q3", "q4"].map(fill), handlers: { ...fillHandlers({ delayMs: 15 }),
    claim_task: (a) => { peak = Math.max(peak, ++inFlight); return { task_id: a.task_id, run_id: `run-${a.task_id}`, context_id: "ctx", row_page_id: `row-${a.task_id}`, brief: {}, artifacts: [], recent_activities: [] }; },
    complete_ai_request: () => { inFlight--; return { task_state: "done" }; } } });
  const model = routedModel({ work: [], request: Array.from({ length: 4 }, () => ({ content: '{"values":[{"row_id":"r1","text":"Short"}]}' })) });
  const { tasks } = await runAgent({ mcp, model, clock: yieldingClock(), maxTasks: 4, maxRequestRuns: 3 });
  expect(peak).toBe(3);
  expect(tasks.filter((t) => t.outcome === "submitted")).toHaveLength(4);
});
it("LN-4 agent_busy puts the task back and retries after five seconds of clock", async () => {
  let claims = 0; const clock = yieldingClock(); const times: number[] = [];
  const mcp = createStubMcp({ tasks: [work("w1")], waits: [seed()], handlers: { claim_task: (a) => {
    times.push(clock.now());
    if (++claims === 1) return { isError: true, data: { code: "agent_busy", limit: 1, active_task_ids: ["other"] } };
    return { task_id: a.task_id, run_id: "run-w1", context_id: "ctx", row_page_id: "row-w1", brief: {}, artifacts: [], recent_activities: [] };
  } } });
  const model = createStubModel([{ tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: [] })] }]);
  const { tasks } = await runAgent({ mcp, model, clock, maxTasks: 1 });
  expect(claims).toBe(2); expect(times[1] - times[0]).toBeGreaterThanOrEqual(5000);
  expect(tasks[0].outcome).toBe("submitted");
});
it("LN-6 aborting ends a waiting work run and a running request, and runAgent resolves", async () => {
  const abort = new AbortController(); let waits = 0;
  const mcp = createStubMcp({ tasks: [work("w1"), fill("q1")], tools: [handOverTool], handlers: { ...fillHandlers(),
    hand_over: () => ({ ok: true }),
    get_ai_request: () => new Promise((resolve) => abort.signal.addEventListener("abort", () => resolve(fillHandlers().get_ai_request()), { once: true })),
    wait_for_task: (_a, opts) => ++waits === 1 ? seed() : new Promise((resolve) => opts?.signal?.addEventListener("abort", () => resolve({ isError: true, data: { code: "aborted" } }), { once: true })) } });
  const model = routedModel({ work: askThenSubmit, request: [{ content: '{"values":[{"row_id":"r1","text":"Short"}]}' }] });
  const run = runAgent({ mcp, model, clock: yieldingClock(), maxTasks: 2, signal: abort.signal });
  await until(() => mcp.calls.some((c) => c.name === "get_ai_request") && waits >= 2);
  const started = Date.now(); abort.abort();
  const { tasks } = await run;
  expect(Date.now() - started).toBeLessThan(1000);
  expect(tasks.map((t) => t.outcome).sort()).toEqual(["aborted", "aborted"]);
  expect(mcp.calls.filter(c => c.name === "hand_over").map(c => c.args.run_id).sort()).toEqual(["run-q1", "run-w1"]);
});

it("retains feedback delivered while the previous run is still notifying", async () => {
  const abort = new AbortController();
  let delivered = false, notified = false, polls = 0;
  const mcp = createStubMcp({ handlers: {
    wait_for_my_tasks: (args) => {
      polls++;
      return { changed: args.after !== "feedback", tasks: !args.after ? [work("w1")] : delivered && args.after !== "feedback" ? [{ ...work("w1"), reason: "feedback" }] : [], next_cursor: delivered ? "feedback" : "initial" };
    },
    submit_for_review: () => { delivered = true; return { task_state: "ready_for_review" }; },
  } });
  const timer = setTimeout(() => abort.abort(), 300);
  try {
    const result = await runAgent({ mcp, model: createStubModel([
      { tool_calls: [toolCall("submit_for_review", { summary: "First", artifact_ids: [] })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Feedback", artifact_ids: [] })] },
    ]), clock: yieldingClock(), maxTasks: 2, signal: abort.signal, channel: { notify: async (event) => {
      if (event.kind === "delivered" && !notified) {
        notified = true;
        const before = polls;
        await until(() => polls > before);
      }
    } } });
    expect(result.tasks.map(t => t.outcome)).toEqual(["submitted", "submitted"]);
  } finally { clearTimeout(timer); abort.abort(); }
});
