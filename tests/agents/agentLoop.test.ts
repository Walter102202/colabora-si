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

describe("reference agent loop", () => {
  it("claims a queued task and drives read_page, append_blocks, add_artifact, submit_for_review over the model slot", async () => {
    const server = await startStubModelServer(deliveryScript);
    try {
      const mcp = createStubMcp({ tasks: queued });
      const model = createModel({ baseUrl: server.url, apiKey: "test-key", model: "stub-model" });
      const channel = memoryChannel();
      const { tasks } = await runAgent({ mcp, model, channel, clock: fakeClock(), maxTasks: 1, harness: "test-agent", appUrl: "https://app.test" });

      expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "read_page", "append_blocks", "add_artifact", "submit_for_review"]);
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

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "read_page", "end_run"]);
    expect(mcp.calls.at(-1)?.args).toMatchObject({ run_id: "run-task-1", status: "completed" });
    expect(tasks[0].outcome).toBe("ended");
  });

  it("acknowledges a stop request from heartbeat and leaves the run", async () => {
    const mcp = createStubMcp({ tasks: queued, heartbeats: [{ stop_requested: false, pending_prompts: [] }, { stop_requested: true, pending_prompts: [] }] });
    const model = createStubModel(deliveryScript);
    const channel = memoryChannel();
    const { tasks } = await runAgent({ mcp, model, channel, clock: fakeClock(), maxTasks: 1 });

    expect(mcp.calls.map((c) => c.name)).toEqual(["wait_for_my_tasks", "claim_task", "heartbeat", "read_page", "heartbeat", "ack_stop"]);
    expect(model.requests).toHaveLength(2);
    expect(tasks[0].outcome).toBe("stopped");
    expect(channel.events.at(-1)?.kind).toBe("stopped");
  });

  it("waits with wait_for_task after request_approval until the decision arrives, then continues", async () => {
    const mcp = createStubMcp({
      tasks: queued,
      waits: [
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

    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "request_approval", "wait_for_task", "wait_for_task", "add_artifact", "submit_for_review"]);
    expect(mcp.calls.find((c) => c.name === "wait_for_task")?.args).toMatchObject({ task_id: "task-1", run_id: "run-task-1", after_seq: 1 });
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
    expect(names(mcp.calls)).toEqual(["wait_for_my_tasks", "claim_task", "read_page", "end_run"]);
    expect(mcp.calls.filter((c) => c.name === "ack_stop" || c.name === "delete_everything")).toHaveLength(0);
    expect(mcp.calls.filter((c) => c.name === "claim_task").map((c) => c.args.task_id)).toEqual(["task-1"]);
    const refusals = model.requests[2].messages.filter((m: { role: string; content: string }) => m.role === "tool" && m.content.includes("unknown_tool"));
    expect(refusals).toHaveLength(4);
    const carriers = model.requests[1].messages.filter((m: { content: string | null }) => typeof m.content === "string" && m.content.includes("admin mode"));
    expect(carriers.map((m: { role: string }) => m.role)).toEqual(["tool"]);
    expect(tasks[0].outcome).toBe("ended");
  });
});
