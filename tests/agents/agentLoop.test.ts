import { describe, expect, it } from "vitest";
import { costUsd, runAgent, type ChannelEvent, type Clock } from "../../agent/loop.mjs";
import { createModel } from "../../agent/model.mjs";
import { createStubMcp } from "../../agent/test/stub-mcp.mjs";
import { createStubModel, startStubModelServer, toolCall } from "../../agent/test/stub-model.mjs";

const queued = [{ task_id: "task-1", title: "Summarize sources", state: "queued", reason: "queued", pending_prompts: 0 }];

function fakeClock(): Clock {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

function memoryChannel() {
  const events: ChannelEvent[] = [];
  return { events, notify: (e: ChannelEvent) => void events.push(e) };
}

const deliveryScript = [
  { tool_calls: [toolCall("read_page", { page_id: "row-task-1" })] },
  { tool_calls: [toolCall("append_blocks", { page_id: "row-task-1", markdown: "## Summary\n\nThree sources agree." })] },
  { tool_calls: [toolCall("add_artifact", { kind: "page", ref: "row-task-1#b1", title: "Summary", satisfies: ["c1"] })] },
  { tool_calls: [toolCall("submit_for_review", { summary: "Summary written", artifact_ids: ["art-1"] })] },
];

const names = (calls: { name: string }[]) => calls.map((c) => c.name).filter((n) => n !== "heartbeat");
/** The answer to the wait_for_task the loop sends right after claim_task to learn the open subtasks and the cursor. */
const seed = (subtasks: object[] = []) => ({ changed: false, stop_requested: false, activities: [], next_seq: 1, task: { task_id: "task-1", state: "working", subtasks } });

describe("reference agent loop", () => {
  it("asks without blocking, keeps working, and hands the answer over when a heartbeat brings it", async () => {
    const answer = { seq: 12, text: "Casual", signal: "feedback", source: "row_panel", author_type: "human", approval_id: "input-1", decision: "respond" };
    const mcp = createStubMcp({
      tasks: queued,
      heartbeats: [{ stop_requested: false, pending_prompts: [] }, { stop_requested: false, pending_prompts: [answer] }],
      waits: [seed(), { changed: true, stop_requested: false, next_seq: 12, activities: [{ ...answer, type: "prompt", excerpt: answer.text }] }],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false })] },
      { tool_calls: [toolCall("append_blocks", { page_id: "row-task-1", markdown: "## Draft\n\nHello." })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Draft written", artifact_ids: ["art-1"] })] },
    ]);
    const channel = memoryChannel();
    const { tasks } = await runAgent({ mcp, model, channel, clock: fakeClock(), maxTasks: 1 });

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "request_input", "append_blocks", "submit_for_review"]);
    expect(mcp.calls.find((c) => c.name === "request_input")?.args).toMatchObject({ blocking: false, run_id: "run-task-1" });
    expect(JSON.parse(model.requests[1].messages.at(-1).content).blocking).toBe(false);
    const third = model.requests[2].messages.map((m: { content?: string }) => m.content ?? "").join("\n");
    expect(third).toContain('Answer to your question "Formal or casual?": Casual');
    expect(third).not.toContain("New messages on the task");
    expect(channel.events.map((e) => e.kind)).toEqual(["claimed", "input_requested", "delivered"]);
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("makes the open question block and waits for it when the model has nothing else to do", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      waits: [
        seed(),
        { changed: true, stop_requested: false, next_seq: 12, activities: [{ seq: 12, type: "prompt", author_type: "human", signal: "feedback", approval_id: "input-1", excerpt: "Casual" }] },
      ],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false })] },
      { content: "Waiting for the tone." },
      { tool_calls: [toolCall("submit_for_review", { summary: "Draft written", artifact_ids: ["art-1"] })] },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "request_input", "await_questions", "wait_for_task", "submit_for_review"]);
    expect(mcp.calls.find((c) => c.name === "await_questions")?.args).toEqual({ run_id: "run-task-1" });
    expect(mcp.calls.some((c) => c.name === "end_run")).toBe(false);
    const third = model.requests[2].messages.map((m: { content?: string }) => m.content ?? "").join("\n");
    expect(third).toContain('Answer to your question "Formal or casual?": Casual');
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("keeps waiting for an approval when the answer to an open question arrives first", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      waits: [
        seed(),
        { changed: true, stop_requested: false, next_seq: 12, activities: [
          { seq: 11, type: "prompt", author_type: "human", signal: "feedback", approval_id: "q-inherited", decision: "respond", excerpt: "Keep it short" },
          { seq: 12, type: "prompt", author_type: "human", signal: "feedback", approval_id: "input-1", decision: "respond", excerpt: "Casual" },
        ] },
        { changed: true, stop_requested: false, next_seq: 13, activities: [{ seq: 13, type: "prompt", author_type: "human", signal: "feedback", approval_id: "appr-1", decision: "approve", excerpt: "" }] },
      ],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false })] },
      { tool_calls: [toolCall("request_approval", { action: "send_email", params: { to: "ops@example.com" }, question: "Send the draft?" })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Draft sent", artifact_ids: ["art-1"] })] },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "request_input", "request_approval", "wait_for_task", "wait_for_task", "submit_for_review"]);
    const third = model.requests[2].messages;
    const approvalResult = JSON.parse(third.filter((m: { role: string }) => m.role === "tool").at(-1).content);
    expect(approvalResult.human_response.map((p: { approval_id: string }) => p.approval_id)).toEqual(["appr-1"]);
    expect(third.at(-1).content).toContain('Answer to your question "Formal or casual?": Casual');
    // A question this run did not ask (inherited from the run that handed over) is not lost either.
    expect(third.at(-1).content).toContain("Answer to an earlier question: Keep it short");
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("hands over an answer given between two runs, which the read after the claim brings", async () => {
    const late = { approval_id: "q-late", question: "Add a P.S.?", decision: "respond", text: "Yes, a short one", answered_at: "2026-10-29T09:30:00Z" };
    const mcp = createStubMcp({ tasks: queued, waits: [{ ...seed(), answered_questions: [late] }] });
    const model = createStubModel([{ tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] }]);
    await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    const first = model.requests[0].messages.map((m: { content?: string }) => m.content ?? "").join("\n");
    expect(first).toContain('Answer to your question "Add a P.S.?": Yes, a short one');
  });

  it("waits on a question an earlier run left open instead of ending the run, without a false warning about it", async () => {
    const mcp = createStubMcp({
      tasks: [{ ...queued[0], reason: "handover" }],
      handlers: {
        claim_task: (a) => ({ task_id: a.task_id, run_id: "run-2", context_id: "ctx", row_page_id: "row-task-1", brief: {}, artifacts: [], recent_activities: [],
          resume: { from: { run_id: "run-1", harness: "codex" }, checkpoint: null, summary: "Handed over.",
            approvals: [{ id: "q-old", kind: "elicitation", status: "pending", decision: null, question: "Formal or casual?" }] } }),
      },
      waits: [
        { ...seed(), open_questions: [{ approval_id: "q-old", question: "Formal or casual?", asked_at: "2026-10-29T09:00:00Z" }] },
        { changed: true, stop_requested: false, next_seq: 12, activities: [{ seq: 12, type: "prompt", author_type: "human", signal: "feedback", approval_id: "q-old", decision: "respond", text: "Casual", excerpt: "Casual" }] },
      ],
    });
    const model = createStubModel([{ content: "Waiting for the tone." }, { tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] }]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "await_questions", "wait_for_task", "submit_for_review"]);
    expect(model.requests[0].messages.map((m: { content?: string }) => m.content ?? "").join("\n")).not.toContain("may have been decided");
    expect(model.requests[1].messages.at(-1).content).toContain('Answer to your question "Formal or casual?": Casual');
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("hands an answer without text to the model as the option chosen, not as the question", async () => {
    const mcp = createStubMcp({ tasks: queued, waits: [seed(), { changed: true, stop_requested: false, next_seq: 12,
      activities: [{ seq: 12, type: "prompt", author_type: "human", signal: "feedback", approval_id: "input-1", decision: "ignore", excerpt: "Formal or casual?" }] }] });
    const model = createStubModel([{ tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false })] }, { content: "Waiting." }]);
    await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    const answer = model.requests[2].messages.at(-1).content;
    expect(answer).not.toContain('"Formal or casual?": Formal or casual?');
    expect(answer).toContain('Answer to your question "Formal or casual?": (ignore, no text)');
  });

  it("hands over an answer read while waiting on subtasks and does not wait for it again", async () => {
    const waits: object[] = [
      seed(),
      { changed: true, stop_requested: false, next_seq: 12, task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-1", state: "working" }] },
        activities: [{ seq: 12, type: "prompt", author_type: "human", signal: "feedback", approval_id: "input-1", decision: "respond", text: "Casual", excerpt: "Casual" }] },
      { changed: true, stop_requested: false, next_seq: 13, task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-1", state: "done" }] }, activities: [] },
    ];
    let idle = 0;
    const mcp = createStubMcp({ tasks: queued, handlers: {
      // Bounded, so a loop that waits for an answer it already read stops instead of hanging the test.
      wait_for_task: (a) => waits.shift() ?? (++idle > 5
        ? { changed: true, stop_requested: true, activities: [], next_seq: a.after_seq }
        : { changed: false, stop_requested: false, activities: [], next_seq: a.after_seq }),
    } });
    const model = createStubModel([
      { tool_calls: [toolCall("create_subtask", { parent_task_id: "task-1", brief: { objective: "Draft" } }), toolCall("request_input", { question: "Formal or casual?", blocking: false })] },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(model.requests[2].messages.at(-1).content).toContain('Answer to your question "Formal or casual?": Casual');
    expect(mcp.calls.some((c) => c.name === "await_questions")).toBe(false);
    expect(idle).toBe(0);
    expect(tasks[0].outcome).toBe("ended");
  });

  it("ends the run instead of waiting when await_questions finds nothing left to wait for", async () => {
    let idle = 0;
    const mcp = createStubMcp({ tasks: queued, handlers: {
      await_questions: () => ({ questions: 0, task_state: "working" }),
      wait_for_task: (a) => (a.after_seq === undefined ? seed() : ++idle > 5
        ? { changed: true, stop_requested: true, activities: [], next_seq: a.after_seq }
        : { changed: false, stop_requested: false, activities: [], next_seq: a.after_seq }),
    } });
    const model = createStubModel([{ tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false })] }, { content: "Waiting." }]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "request_input", "await_questions", "end_run"]);
    // One more read between them, for an answer or a stop that came after the turn's heartbeat.
    expect(mcp.calls.map((c) => c.name).slice(-3)).toEqual(["await_questions", "heartbeat", "end_run"]);
    expect(idle).toBe(0);
    expect(tasks[0].outcome).toBe("ended");
  });

  it("hands over an answer given after the turn's heartbeat and before await_questions instead of ending the run", async () => {
    const answer = { seq: 12, type: "prompt", author_type: "human", signal: "feedback", source: "row_panel", approval_id: "input-1", decision: "respond", text: "Casual", excerpt: "Casual" };
    let answered = false;
    const after = (a: Record<string, unknown>) => Number(a.after_seq ?? 0);
    const mcp = createStubMcp({ tasks: queued, handlers: {
      // The person answered just before: nothing is pending any more, so the task stays working.
      await_questions: () => { answered = true; return { questions: 0, task_state: "working" }; },
      heartbeat: (a) => ({ stop_requested: false, brief_stale: false, pending_prompts: answered && after(a) < 12 ? [answer] : [] }),
    } });
    const model = createStubModel([
      { tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false })] },
      { content: "Waiting for the tone." },
      { tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(model.requests[2].messages.at(-1).content).toContain('Answer to your question "Formal or casual?": Casual');
    expect(mcp.calls.some((c) => c.name === "end_run")).toBe(false);
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("reads once more before ending the run, so an answer a failed heartbeat missed still reaches the model", async () => {
    const answer = { seq: 12, type: "prompt", author_type: "human", signal: "feedback", source: "row_panel", approval_id: "input-1", decision: "respond", text: "Casual", excerpt: "Casual" };
    let beats = 0;
    const after = (a: Record<string, unknown>) => Number(a.after_seq ?? 0);
    const mcp = createStubMcp({ tasks: queued, handlers: {
      await_questions: () => ({ questions: 0, task_state: "working" }),
      heartbeat: (a) => (++beats === 2
        ? { isError: true as const, data: { code: "transport_error" } }
        : { stop_requested: false, brief_stale: false, pending_prompts: beats > 2 && after(a) < 12 ? [answer] : [] }),
    } });
    const model = createStubModel([
      { tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false })] },
      { content: "Waiting for the tone." },
      { tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(model.requests[2].messages.at(-1).content).toContain('Answer to your question "Formal or casual?": Casual');
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("acknowledges a stop asked after the turn's heartbeat instead of ending the run as if nothing happened", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      heartbeats: [{ stop_requested: false, pending_prompts: [] }, { stop_requested: false, pending_prompts: [] }, { stop_requested: true, pending_prompts: [] }],
      handlers: { await_questions: () => ({ questions: 0, task_state: "cancelled" }) },
    });
    const model = createStubModel([{ tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false })] }, { content: "Waiting." }]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(names(mcp.calls).slice(-2)).toEqual(["await_questions", "ack_stop"]);
    expect(tasks[0].outcome).toBe("stopped");
  });

  it("names the questions still open when it hands over one answer while the others hold the delivery", async () => {
    let asked = 0;
    const answerTo = (seq: number, id: string, text: string) => ({ changed: true, stop_requested: false, next_seq: seq,
      activities: [{ seq, type: "prompt", author_type: "human", signal: "feedback", approval_id: id, decision: "respond", text, excerpt: text }] });
    const mcp = createStubMcp({
      tasks: queued,
      handlers: { request_input: (a) => ({ approval_id: `input-${++asked}`, status: "pending", blocking: a.blocking !== false }) },
      waits: [seed(), answerTo(12, "input-1", "Casual"), answerTo(13, "input-2", "Yes")],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false }), toolCall("request_input", { question: "Add a P.S.?", blocking: false })] },
      { content: "Waiting." },
      { content: "Waiting for the other one." },
      { tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    const first = model.requests[2].messages.at(-1).content;
    expect(first).toContain('Answer to your question "Formal or casual?": Casual');
    expect(first).toMatch(/Still waiting for an answer to "Add a P\.S\.\?"[^\n]*waiting_on_human/);
    expect(first).not.toContain('"Formal or casual?",');
    const last = model.requests[3].messages.at(-1).content;
    expect(last).toContain('Answer to your question "Add a P.S.?": Yes');
    expect(last).not.toContain("Still waiting");
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("does not say that a question asked after the wait holds the delivery", async () => {
    let asked = 0;
    let beats = 0;
    const answerQ3 = { seq: 20, text: "Blue", signal: "feedback", source: "row_panel", author_type: "human", approval_id: "q3", decision: "respond" };
    const mcp = createStubMcp({
      tasks: queued,
      waits: [seed(), { changed: true, stop_requested: false, next_seq: 12, activities: [{ seq: 12, type: "prompt", author_type: "human", signal: "feedback", approval_id: "q1", decision: "respond", text: "Casual", excerpt: "Casual" }] }],
      handlers: {
        request_input: (a) => ({ approval_id: `q${++asked}`, status: "pending", blocking: a.blocking !== false }),
        // Only q1 is open when the loop waits; q2 and q3 come later, without blocking, and are never waited on.
        await_questions: () => ({ questions: 1, task_state: "input_required" }),
        heartbeat: () => ({ stop_requested: false, brief_stale: false, pending_prompts: ++beats === 4 ? [answerQ3] : [] }),
      },
    });
    const model = createStubModel([
      { tool_calls: [toolCall("request_input", { question: "Formal or casual?", blocking: false })] },
      { content: "Waiting for the tone." },
      { tool_calls: [toolCall("request_input", { question: "Add a P.S.?", blocking: false }), toolCall("request_input", { question: "Which colour?", blocking: false })] },
      { tool_calls: [toolCall("append_blocks", { page_id: "row-task-1", markdown: "Draft" })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    const afterQ3 = model.requests[4].messages.at(-1).content;
    expect(afterQ3).toContain('Answer to your question "Which colour?": Blue');
    expect(afterQ3).not.toContain("waiting_on_human");
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("hands a late answer to the model once, though its message also comes after the cursor", async () => {
    const late = { approval_id: "q-late", question: "Add a P.S.?", decision: "respond", text: "Yes, a short one", answered_at: "2026-10-29T09:30:00Z" };
    const prompt = { seq: 12, text: "Yes, a short one", signal: "feedback", source: "row_panel", author_type: "human", approval_id: "q-late", decision: "respond" };
    const mcp = createStubMcp({
      tasks: queued,
      waits: [{ ...seed(), next_seq: 11, answered_questions: [late] }],
      heartbeats: [{ stop_requested: false, brief_stale: false, pending_prompts: [prompt] }],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("read_page", { page_id: "row-task-1" })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] },
    ]);
    await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    const text = model.requests[1].messages.map((m: { content?: string }) => m.content ?? "").join("\n");
    expect(text.split("Yes, a short one").length - 1).toBe(1);
    expect(text).not.toContain("New messages on the task");
  });

  it("does not wait at the claim for a request whose answer the seed already brought", async () => {
    const mcp = createStubMcp({
      tasks: [{ ...queued[0], reason: "handover" }],
      handlers: {
        claim_task: (a) => ({ task_id: a.task_id, run_id: "run-2", context_id: "ctx", row_page_id: "row-task-1", brief: {}, artifacts: [], recent_activities: [],
          resume: { from: { run_id: "run-1", harness: "codex" }, checkpoint: null, summary: "Handed over.",
            approvals: [{ id: "q-block", kind: "elicitation", status: "pending", decision: null, question: "Which list?" }] } }),
      },
      waits: [
        { ...seed(), next_seq: 11, task: { task_id: "task-1", state: "input_required", subtasks: [] },
          answered_questions: [{ approval_id: "q-block", question: "Which list?", decision: "respond", text: "The second one", answered_at: "2026-10-29T09:30:00Z" }] },
        { changed: true, stop_requested: false, next_seq: 12,
          activities: [{ seq: 12, type: "prompt", author_type: "human", signal: "feedback", approval_id: "q-block", decision: "respond", text: "The second one", excerpt: "The second one" }] },
      ],
    });
    const model = createStubModel([{ tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] }]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "submit_for_review"]);
    const first = model.requests[0].messages.map((m: { content?: string }) => m.content ?? "").join("\n");
    expect(first.split("The second one").length - 1).toBe(1);
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("tells the model in its first message which questions an earlier run left open", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      waits: [{ ...seed(), open_questions: [{ approval_id: "q-old", question: "Formal or casual?", asked_at: "2026-10-29T09:00:00Z" }] }],
    });
    const model = createStubModel([{ tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] }]);
    await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    const first = model.requests[0].messages[1].content;
    expect(first).toMatch(/Questions an earlier run asked[^\n]*\n- "Formal or casual\?"/);
    expect(first).toMatch(/answers arrive as messages/);
  });

  it("claims a queued task and drives read_page, append_blocks, add_artifact, submit_for_review over the model slot", async () => {
    const server = await startStubModelServer(deliveryScript);
    try {
      const mcp = createStubMcp({ tasks: queued });
      const model = createModel({ baseUrl: server.url, apiKey: "test-key", model: "stub-model" });
      const channel = memoryChannel();
      const { tasks } = await runAgent({ mcp, model, channel, clock: fakeClock(), maxTasks: 1, harness: "test-agent", appUrl: "https://app.test" });

      expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "read_page", "append_blocks", "add_artifact", "submit_for_review"]);
      expect(mcp.calls[1].args).toEqual({ task_id: "task-1", harness: "test-agent" });
      expect(mcp.calls.find((c) => c.name === "submit_for_review")?.args.run_id).toBe("run-task-1");
      expect(tasks[0].outcome).toBe("submitted");
      expect(server.requests).toHaveLength(4);
      const offered = server.requests[0].tools.map((t: { function: { name: string } }) => t.function.name);
      expect(offered).toContain("read_page");
      expect(offered).not.toContain("claim_task");
      expect(channel.events.map((e) => e.kind)).toEqual(["claimed", "delivered"]);
    } finally {
      await server.close();
    }
  });

  it("ends the run with end_run when the model stops without submitting", async () => {
    const mcp = createStubMcp({ tasks: queued });
    const model = createStubModel([{ tool_calls: [toolCall("read_page", { page_id: "row-task-1" })] }, { content: "I cannot finish this." }]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "read_page", "end_run"]);
    expect(mcp.calls.at(-1)?.args).toMatchObject({ run_id: "run-task-1", status: "completed" });
    expect(tasks[0].outcome).toBe("ended");
  });

  it("acknowledges a stop request from heartbeat and leaves the run", async () => {
    const mcp = createStubMcp({ tasks: queued, heartbeats: [{ stop_requested: false, pending_prompts: [] }, { stop_requested: true, pending_prompts: [] }] });
    const model = createStubModel(deliveryScript);
    const channel = memoryChannel();
    const { tasks } = await runAgent({ mcp, model, channel, clock: fakeClock(), maxTasks: 1 });

    expect(mcp.calls.map((c) => c.name)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "heartbeat", "read_page", "heartbeat", "ack_stop"]);
    expect(model.requests).toHaveLength(2);
    expect(tasks[0].outcome).toBe("stopped");
    expect(channel.events.at(-1)?.kind).toBe("stopped");
  });

  it("waits with wait_for_task after request_approval until the decision arrives, then continues", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      waits: [
        seed(),
        { changed: false, stop_requested: false, activities: [], next_seq: 1 },
        { changed: true, stop_requested: false, activities: [{ seq: 12, type: "prompt", author_type: "human", signal: "approval_decided", excerpt: "Approved" }], next_seq: 12 },
      ],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("request_approval", { action: "send_email", params: { to: "team" }, question: "Send the summary to the team?" })] },
      { tool_calls: [toolCall("add_artifact", { kind: "external", ref: "email", title: "Email sent", satisfies: ["c1"] })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Email sent", artifact_ids: ["art-1"] })] },
    ]);
    const channel = memoryChannel();
    const { tasks } = await runAgent({ mcp, model, channel, clock: fakeClock(), maxTasks: 1, appUrl: "https://app.test" });

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "request_approval", "wait_for_task", "wait_for_task", "add_artifact", "submit_for_review"]);
    const waits = mcp.calls.filter((c) => c.name === "wait_for_task");
    expect(waits[0].args).toEqual({ task_id: "task-1", run_id: "run-task-1" });
    expect(waits[1].args).toMatchObject({ task_id: "task-1", run_id: "run-task-1", after_seq: 1 });
    const approvalResult = model.requests[1].messages.at(-1);
    expect(approvalResult.role).toBe("tool");
    expect(JSON.parse(approvalResult.content).human_response[0].signal).toBe("approval_decided");
    expect(channel.events.find((e) => e.kind === "approval_pending")?.link).toBe("https://app.test/p/row-task-1?task=task-1");
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("reports accumulated usage in heartbeat with the measured cost", async () => {
    const mcp = createStubMcp({ tasks: queued });
    const model = createStubModel(deliveryScript.map((step, i) => ({ ...step, usage: { prompt_tokens: 1000 * (i + 1), completion_tokens: 200 } })));
    const prices = { input: 2, output: 8 };
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1, prices });

    const usages = mcp.calls.filter((c) => c.name === "heartbeat").map((c) => c.args.usage);
    expect(usages).toHaveLength(4);
    expect(usages[0]).toEqual({ input_tokens: 1000, output_tokens: 200, model: "stub-model", cost_usd: costUsd({ input_tokens: 1000, output_tokens: 200 }, prices) });
    expect(usages[0].cost_usd).toBeCloseTo(0.0036, 10);
    const sent = usages.reduce((s, u) => ({ input: s.input + u.input_tokens, output: s.output + u.output_tokens, cost: s.cost + u.cost_usd }), { input: 0, output: 0, cost: 0 });
    expect(sent.input).toBe(10_000);
    expect(sent.output).toBe(800);
    expect(sent.cost).toBeCloseTo((10_000 * 2 + 800 * 8) / 1e6, 10);
    expect(tasks[0].usage.cost_usd).toBeCloseTo(0.0264, 10);
  });

  it("as reviewer: reviews the subtask named by review_of from its own run and reports a delivery", async () => {
    const mcp = createStubMcp({
      tasks: [{ task_id: "task-r", title: "Review the report", state: "queued", reason: "queued", pending_prompts: 0 }],
      handlers: { claim_task: (a) => ({ task_id: a.task_id, run_id: `run-${a.task_id}`, row_page_id: `row-${a.task_id}`,
        brief: { objective: "Review the report", done_when: [{ id: "r1", text: "One finding per criterion" }], policies: { review_of: "task-sub" } }, artifacts: [], recent_activities: [] }) },
    });
    const model = createStubModel([
      { tool_calls: [toolCall("read_page", { page_id: "row-task-sub" })] },
      { tool_calls: [toolCall("review_task", { task_id: "task-sub", verdict: "approved", findings: [{ criterion_id: "c1", status: "verified" }] })] },
      { content: "Review recorded." },
    ]);
    const channel = memoryChannel();
    const { tasks } = await runAgent({ mcp, model, channel, clock: fakeClock(), maxTasks: 1 });
    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "read_page", "review_task", "end_run"]);
    expect(mcp.calls.find((c) => c.name === "review_task")?.args).toMatchObject({ task_id: "task-sub", run_id: "run-task-r", verdict: "approved" });
    expect(tasks[0].outcome).toBe("submitted");
    expect(channel.events.map((e) => e.kind)).toEqual(["claimed", "delivered"]);
  });

  it("as Lead: after create_subtask it waits on the parent until a subtask is ready, then tells the model", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      waits: [
        seed(),
        { changed: true, stop_requested: false, activities: [], next_seq: 1,
          task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-1", state: "ready_for_review", review_state: "pending" }] } },
        { changed: true, stop_requested: false, activities: [], next_seq: 2,
          task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-1", state: "done", review_state: "approved" }, { task_id: "sub-2", state: "done", review_state: "none" }] } },
      ],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("create_subtask", { parent_task_id: "task-1", delegate_agent_id: "worker-1", brief: { objective: "Write", done_when: [{ id: "c1", text: "Written" }] } })] },
      { content: "Waiting for the worker." },
      { tool_calls: [toolCall("create_subtask", { parent_task_id: "task-1", delegate_agent_id: "reviewer-1", brief: { objective: "Review", done_when: [{ id: "r1", text: "Reviewed" }], policies: { review_of: "sub-1" } } })] },
      { content: "Waiting for the review." },
      { content: "Done for now." },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1, reviewerAgentId: "reviewer-1" });
    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "create_subtask", "wait_for_task", "create_subtask", "wait_for_task", "end_run"]);
    expect(model.requests[2].messages.at(-1).content).toMatch(/sub-1.*ready_for_review/);
    expect(model.requests[4].messages.at(-1).content).toMatch(/sub-2.*done/);
    expect(model.requests[0].messages[0].content).toContain("reviewer-1");
    expect(model.requests[0].messages[0].content).toContain("After create_subtask, end your turn");
    expect(tasks[0].outcome).toBe("ended");
  });

  it("as Lead: ends the run once every subtask is closed instead of waiting forever", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      waits: [
        seed(),
        { changed: true, stop_requested: false, activities: [], next_seq: 2,
          task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-1", state: "done", review_state: "approved" }] } },
      ],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("create_subtask", { parent_task_id: "task-1", delegate_agent_id: "worker-1", brief: { objective: "Write", done_when: [{ id: "c1", text: "Written" }] } })] },
      { content: "Waiting for the worker." },
      { content: "All done." },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });
    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "create_subtask", "wait_for_task", "end_run"]);
    const update = JSON.parse(model.requests[2].messages.at(-1).content.replace(/^[^{]*/, ""));
    expect(update.all_subtasks_closed).toBe(true);
    expect(update.subtasks.map((s: { task_id: string }) => s.task_id)).toEqual(["sub-1"]);
    expect(tasks[0].outcome).toBe("ended");
  });

  it("as Lead resuming a task: learns the open subtasks at claim and waits on them", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      waits: [
        { changed: false, stop_requested: false, activities: [], next_seq: 7,
          task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-9", state: "working", review_state: "none" }] } },
        { changed: true, stop_requested: false, activities: [], next_seq: 8,
          task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-9", state: "done", review_state: "approved" }] } },
      ],
    });
    const model = createStubModel([{ content: "Picking up where the other run left off." }, { content: "Done." }]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });
    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "wait_for_task", "end_run"]);
    expect(model.requests[0].messages[1].content).toMatch(/sub-9[\s\S]*working/);
    expect(mcp.calls.filter((c) => c.name === "heartbeat")[0].args.after_seq).toBe(7);
    expect(model.requests[1].messages.at(-1).content).toMatch(/sub-9.*done/);
    expect(tasks[0].outcome).toBe("ended");
  });

  it("as Lead: its own activities and unchanged subtasks are not news; a person's message is, and close_subtask releases the wait", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      waits: [
        seed(),
        { changed: true, stop_requested: false, next_seq: 5, activities: [{ seq: 5, type: "action", author_type: "agent", excerpt: "Lead note" }],
          task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-1", state: "working", review_state: "none" }] } },
        { changed: true, stop_requested: false, next_seq: 6, activities: [{ seq: 6, type: "prompt", author_type: "human", signal: "feedback", excerpt: "Hurry up" }],
          task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-1", state: "working", review_state: "none" }] } },
      ],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("create_subtask", { parent_task_id: "task-1", delegate_agent_id: "worker-1", brief: { objective: "Write", done_when: [{ id: "c1", text: "Written" }] } })] },
      { content: "Waiting." },
      { tool_calls: [toolCall("close_subtask", { task_id: "sub-1" })] },
      { content: "Done." },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });
    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "create_subtask", "wait_for_task", "wait_for_task", "close_subtask", "end_run"]);
    const update = model.requests[2].messages.at(-1).content;
    expect(update).toContain("Hurry up");
    expect(update).not.toContain("Lead note");
    expect(mcp.calls.filter((c) => c.name === "wait_for_task").at(-1)?.args.after_seq).toBe(5);
    expect(tasks[0].outcome).toBe("ended");
  });

  it("as Lead: a person's message that arrives through heartbeat while waiting on subtasks reaches the model", async () => {
    let t = 0;
    const jumpingClock: Clock = { now: () => (t += 6 * 60 * 1000), sleep: async (ms) => void (t += ms) };
    const mcp = createStubMcp({
      tasks: queued,
      heartbeats: [
        { stop_requested: false, pending_prompts: [] },
        { stop_requested: false, pending_prompts: [{ seq: 9, signal: "feedback", source: "row_panel", text: "Use the short version" }] },
      ],
      waits: [
        seed(),
        { changed: true, stop_requested: false, activities: [], next_seq: 10,
          task: { task_id: "task-1", state: "working", subtasks: [{ task_id: "sub-1", state: "done", review_state: "approved" }] } },
      ],
    });
    const model = createStubModel([
      { tool_calls: [toolCall("create_subtask", { parent_task_id: "task-1", delegate_agent_id: "worker-1", brief: { objective: "Write", done_when: [{ id: "c1", text: "Written" }] } })] },
      { content: "Waiting." },
      { content: "Noted." },
      { content: "Done." },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: jumpingClock, maxTasks: 1 });
    expect(model.requests[2].messages.at(-1).content).toContain("Use the short version");
    expect(mcp.calls.filter((c) => c.name === "wait_for_task")).toHaveLength(2);
    expect(tasks[0].outcome).toBe("ended");
  });

  it("as reviewer: refuses submit_for_review after the review closed the review task and tells the model why", async () => {
    const mcp = createStubMcp({
      tasks: [{ task_id: "task-r", title: "Review the report", state: "queued", reason: "queued", pending_prompts: 0 }],
      handlers: { claim_task: (a) => ({ task_id: a.task_id, run_id: `run-${a.task_id}`, row_page_id: `row-${a.task_id}`,
        brief: { objective: "Review the report", done_when: [{ id: "r1", text: "One finding per criterion" }], policies: { review_of: "task-sub" } }, artifacts: [], recent_activities: [] }) },
    });
    const model = createStubModel([
      { tool_calls: [toolCall("review_task", { task_id: "task-sub", verdict: "approved", findings: [{ criterion_id: "c1", status: "verified" }] })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Reviewed", artifact_ids: [] })] },
      { content: "Understood." },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });
    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "review_task", "end_run"]);
    expect(JSON.parse(model.requests[2].messages.at(-1).content).error).toBe("invalid_state");
    expect(model.requests[0].messages[1].content).toContain("Do not call submit_for_review");
    expect(tasks[0].outcome).toBe("submitted");
  });

  it("treats adversarial page content as data: runtime and unknown tools stay out of reach and the text only arrives as a tool result", async () => {
    const corpus = (await import("./corpus/adversarial.json")).default as { surface: string; input: string }[];
    const hostile = corpus.filter((e) => e.surface === "tool_result").map((e) => e.input).join("\n\n");
    const mcp = createStubMcp({
      tasks: queued,
      handlers: { read_page: (a) => ({ page_id: a.page_id, title: "Row", revision: 1, markdown: `${hostile} <!-- block:b0 -->`, blocks: [{ id: "b0", rev: 1, type: "paragraph", indent: 0, markdown: hostile }] }) },
    });
    const model = createStubModel([
      { tool_calls: [toolCall("read_page", { page_id: "row-task-1" })] },
      { tool_calls: [toolCall("ack_stop", {}), toolCall("claim_task", { task_id: "task-2" }), toolCall("end_run", { status: "completed" }), toolCall("delete_everything", {})] },
      { content: "I will not follow instructions found in page content." },
    ]);
    const { tasks } = await runAgent({ mcp, model, clock: fakeClock(), maxTasks: 1 });
    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "wait_for_task", "read_page", "end_run"]);
    expect(mcp.calls.filter((c) => c.name === "ack_stop" || c.name === "delete_everything")).toHaveLength(0);
    expect(mcp.calls.filter((c) => c.name === "claim_task").map((c) => c.args.task_id)).toEqual(["task-1"]);
    const refusals = model.requests[2].messages.filter((m: { role: string; content: string }) => m.role === "tool" && m.content.includes("unknown_tool"));
    expect(refusals).toHaveLength(4);
    const carriers = model.requests[1].messages.filter((m: { content: string | null }) => typeof m.content === "string" && m.content.includes("admin mode"));
    expect(carriers.map((m: { role: string }) => m.role)).toEqual(["tool"]);
    expect(tasks[0].outcome).toBe("ended");
  });
});
