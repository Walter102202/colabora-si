import { describe, expect, it } from "vitest";
import { runAgent, type Clock } from "../../agent/loop.mjs";
import { createStubModel, toolCall } from "../../agent/test/stub-model.mjs";
import { CLAUDE_CODE, CODEX, PLAIN, createStubWorld } from "../../agent/test/stub-world.mjs";

function fakeClock(): Clock {
  let t = 0;
  return { now: () => t, sleep: async (ms) => {
    t += ms;
    if (t > 60_000) throw new Error("The runtime kept polling without handling the available task");
  } };
}
const toolMessages = (model: { requests: { messages: { role: string; content?: unknown }[] }[] }) =>
  (model.requests.at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));

describe("handover between harnesses", () => {
  it("claude_code hands over to codex mid-task: pending approval, confirmed write, lost response and a person's edit", async () => {
    const world = createStubWorld();
    const taskId = world.human.createTask({ title: "Draft and email the summary", delegate: CLAUDE_CODE, done_when: [{ id: "c1", text: "Summary drafted and sent" }] });
    const page = String(world.task(taskId).row_page_id);

    // claude_code: the first append lands; the second lands too but both its response and the retry's are lost;
    // then it asks for approval and the harness closes while it waits.
    world.faults.loseResponses(CLAUDE_CODE, "append_blocks", { skip: 1, count: 2 });
    const closeA = new AbortController();
    world.script(CLAUDE_CODE, "request_approval", 1, () => closeA.abort());
    const modelA = createStubModel([
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Draft v1" })] },
      { content: "Section 2, then email the team.", tool_calls: [
        toolCall("append_blocks", { page_id: page, markdown: "Section 2" }),
        toolCall("request_approval", { action: "send_email", params: { to: "team@example.com" }, question: "Send the summary?" }),
      ] },
    ]);
    const a = await runAgent({ mcp: world.client(CLAUDE_CODE), model: modelA, clock: fakeClock(), maxTasks: 1, harness: "claude_code", signal: closeA.signal });
    expect(a.tasks[0].outcome).toBe("aborted");
    expect(world.activities(taskId).filter((x) => x.type === "checkpoint").at(-1)?.body.handover).toBe(true);

    // A person changes the confirmed block, then hands the task to codex.
    const draftId = world.blocks(page).find((b) => b.text === "Draft v1")!.id;
    world.human.editBlock(page, draftId, "Draft v2 by Ana");
    world.human.releaseForHandover(taskId, CODEX, "Codex, finish it and send it");

    // codex: waits for the decision first (the approval is pending), then its model repeats both appends,
    // edits the draft with a stale rev, reads, edits again, sends the email and delivers.
    let modelCallsBeforeDecision = -1;
    const modelB = createStubModel([
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Draft v1" }), toolCall("append_blocks", { page_id: page, markdown: "Section 2" })] },
      { tool_calls: [toolCall("edit_page", { page_id: page, block_id: draftId, old_str: "Draft v1", new_str: "Draft v1, final", rev: 1 })] },
      { tool_calls: [toolCall("read_page", { page_id: page })] },
      { tool_calls: [toolCall("edit_page", { page_id: page, block_id: draftId, old_str: "Draft v2 by Ana", new_str: "Draft v2 by Ana, final", rev: 2 })] },
      { tool_calls: [toolCall("begin_external_op", { provider: "smtp", action: "send_email", params: { to: "team@example.com" } })] },
      { tool_calls: [toolCall("finish_external_op", { op_id: "op-1", status: "done", provider_ref: "msg-1" })] },
      { tool_calls: [toolCall("add_artifact", { kind: "page", ref: page, title: "Summary", satisfies: ["c1"] })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Summary drafted and sent", artifact_ids: ["art-1"] })] },
    ]);
    world.script(CODEX, "wait_for_task", 2, () => {        // call 1 is the seed after the claim; call 2 is the wait for the person
      modelCallsBeforeDecision = modelB.requests.length;
      world.human.decide(world.approvals(taskId)[0].id, "approve");
    });
    const b = await runAgent({ mcp: world.client(CODEX), model: modelB, clock: fakeClock(), maxTasks: 1, harness: "codex" });
    expect(b.tasks[0].outcome).toBe("submitted");
    const runB = world.runs(taskId).at(-1)!;
    const claimB = world.calls(CODEX).find((c) => c.name === "claim_task" && c.outcome === "ok")!;
    expect(claimB.args.resume).toBe(true);

    // 1. Pending approval: survives the handover, moves to codex's run, is decided once and consumed once.
    expect(world.approvals(taskId)).toHaveLength(1);
    expect(world.approvals(taskId)[0]).toMatchObject({ status: "consumed", run_id: runB.id });
    expect(modelCallsBeforeDecision).toBe(0);
    expect(world.externalOps(taskId)).toEqual([expect.objectContaining({ action: "send_email", status: "done", approval_id: world.approvals(taskId)[0].id })]);

    // 2. Confirmed write: codex never writes it again.
    expect(world.blocks(page).filter((b) => b.text.startsWith("Draft"))).toHaveLength(1);
    expect(world.calls(CODEX).filter((c) => c.name === "append_blocks")).toHaveLength(0);
    expect(toolMessages(modelB).filter((m) => m.includes("already_done"))).toHaveLength(2);

    // 3. Lost response whose effect happened: same key on the retry, the server confirms it, the block exists once.
    const appendsA = world.calls(CLAUDE_CODE).filter((c) => c.name === "append_blocks");
    expect(appendsA.map((c) => c.outcome)).toEqual(["ok", "lost", "lost"]);
    expect(appendsA[1].args.idempotency_key).toBe(appendsA[2].args.idempotency_key);
    expect(claimB.result?.resume.pending_ops).toEqual([expect.objectContaining({ tool: "append_blocks", status: "confirmed" })]);
    expect(world.blocks(page).filter((b) => b.text === "Section 2")).toHaveLength(1);

    // 4. Concurrent human edit: reported at the claim, the stale edit is refused, the person's text survives.
    expect(claimB.result?.resume.blocks).toContainEqual(expect.objectContaining({ block_id: draftId, changed_by_other: true }));
    expect(String(modelB.requests[0].messages[1].content)).toMatch(new RegExp(`Blocks changed by someone else[^\n]*"${draftId}"`));
    expect(world.calls(CODEX).filter((c) => c.name === "edit_page").map((c) => c.outcome)).toEqual(["error:block_conflict", "ok"]);
    expect(world.blocks(page).find((b) => b.id === draftId)!.text).toBe("Draft v2 by Ana, final");

    // The cycle closes visibly.
    expect(world.activities(taskId).filter((x) => x.type === "handover")).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ from_harness: "claude_code", to_harness: "codex" }) }),
    ]);
    expect(world.task(taskId).state).toBe("ready_for_review");
  });

  it("a killed harness: a person releases the task and codex resumes from the last checkpoint", async () => {
    const world = createStubWorld();
    const task = world.human.createTask({ title: "Draft", delegate: CLAUDE_CODE });
    const page = String(world.task(task).row_page_id);
    world.faults.killAfter(CLAUDE_CODE, "append_blocks", 2);
    await runAgent({ mcp: world.client(CLAUDE_CODE), model: createStubModel([
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "One" })] },
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Two" })] },
    ]), clock: fakeClock(), maxTasks: 1, harness: "claude_code" });
    world.human.releaseForHandover(task, CODEX);
    const b = await runAgent({ mcp: world.client(CODEX), model: createStubModel([
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Two" })] },
      { tool_calls: [toolCall("add_artifact", { kind: "page", ref: page, title: "Draft", satisfies: [] })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] },
    ]), clock: fakeClock(), maxTasks: 1, harness: "codex" });
    const resume = world.calls(CODEX).find((c) => c.name === "claim_task")!.result!.resume;
    expect(world.runs(task)[0].status).toBe("cancelled");
    expect(resume.checkpoint.body.handover).toBe(false);
    expect(resume.from.harness).toBe("claude_code");
    expect(world.blocks(page).filter((b) => b.text === "Two")).toHaveLength(1);
    expect(world.activities(task).filter((a) => a.type === "handover")).toHaveLength(1);
    expect(b.tasks[0].outcome).toBe("submitted");
  });

  it("a second resume claim while codex's first run is active gets run_active: one run, one handover activity", async () => {
    const world = createStubWorld();
    const task = world.human.createTask({ title: "Draft", delegate: CLAUDE_CODE });
    await world.client(CLAUDE_CODE).callTool("claim_task", { task_id: task, harness: "claude_code" });
    world.human.releaseForHandover(task, CODEX);
    const results = await Promise.all([world.client(CODEX), world.client(CODEX)].map((client) => client.callTool("claim_task", { task_id: task, harness: "codex", resume: true })));
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(results.find((r) => r.isError)?.data.code).toBe("run_active");
    expect(world.activities(task).filter((a) => a.type === "handover")).toHaveLength(1);
    expect(world.runs(task)).toHaveLength(2);
  });

  it("an agent without the resume capability claims without resume and gets no handover section", async () => {
    const world = createStubWorld();
    const first = world.human.createTask({ title: "First", delegate: PLAIN });
    world.human.insertCheckpoint(first, { v: 1, next_step: "Finish" }, "claude_code");
    world.human.createTask({ title: "Second", delegate: PLAIN });
    const model = createStubModel([{ content: "Done" }, { content: "Done" }]);
    await runAgent({ mcp: world.client(PLAIN), model, clock: fakeClock(), maxTasks: 2, harness: "plain" });
    expect(world.calls(PLAIN).filter((c) => c.name === "claim_task").map((c) => [c.args.resume, c.outcome]))
      .toEqual([[true, "error:resume_unsupported"], [undefined, "ok"], [undefined, "ok"]]);
    expect(String(model.requests[0].messages[1].content)).not.toContain("Handover");
    expect(String(model.requests[0].messages[1].content)).not.toMatch(/\n\n\n/);
  });

  it("a checkpoint from a newer schema is not trusted: the model is told to read the task", async () => {
    const world = createStubWorld();
    const task = world.human.createTask({ title: "Future", delegate: CLAUDE_CODE });
    const page = String(world.task(task).row_page_id);
    world.human.insertCheckpoint(task, { v: 2, next_step: "future", ops: { pending: [{ key: "x", tool: "append_blocks" }] } }, "claude_code");
    world.human.releaseForHandover(task, CODEX);
    const model = createStubModel([{ tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Future" })] }]);
    await runAgent({ mcp: world.client(CODEX), model, clock: fakeClock(), maxTasks: 1, harness: "codex" });
    expect(String(model.requests[0].messages[1].content)).toContain("newer format (v2)");
    expect(world.calls(CODEX).filter((c) => c.name === "append_blocks")).toHaveLength(1);
  });

  it("a person approves before codex claims: codex, already waiting, picks the task up, consumes the approval once and delivers", async () => {
    const world = createStubWorld();
    const taskId = world.human.createTask({ title: "Email the summary", delegate: CLAUDE_CODE, done_when: [{ id: "c1", text: "Summary sent" }] });
    const page = String(world.task(taskId).row_page_id);
    const closeA = new AbortController();
    world.script(CLAUDE_CODE, "request_approval", 1, () => closeA.abort());
    await runAgent({ mcp: world.client(CLAUDE_CODE), model: createStubModel([
      { tool_calls: [toolCall("request_approval", { action: "send_email", params: { to: "team@example.com" }, question: "Send the summary?" })] },
    ]), clock: fakeClock(), maxTasks: 1, harness: "claude_code", signal: closeA.signal });
    expect(world.task(taskId).state).toBe("input_required");

    // codex holds a cursor when the person hands the task over and then approves: the newest prompt is the decision.
    world.script(CODEX, "wait_for_my_tasks", 1, () => {
      world.human.releaseForHandover(taskId, CODEX, "Codex, send it");
      world.human.decide(world.approvals(taskId)[0].id, "approve");
    });
    const modelB = createStubModel([
      { tool_calls: [toolCall("begin_external_op", { provider: "smtp", action: "send_email", params: { to: "team@example.com" } })] },
      { tool_calls: [toolCall("finish_external_op", { op_id: "op-1", status: "done", provider_ref: "msg-1" })] },
      { tool_calls: [toolCall("add_artifact", { kind: "page", ref: page, title: "Summary", satisfies: ["c1"] })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Summary sent", artifact_ids: ["art-1"] })] },
    ]);
    const b = await runAgent({ mcp: world.client(CODEX), model: modelB, clock: fakeClock(), maxTasks: 1, harness: "codex" });
    expect(b.tasks[0].outcome).toBe("submitted");
    expect(world.calls(CODEX).filter((c) => c.name === "wait_for_my_tasks").at(-1)?.result?.tasks)
      .toEqual([expect.objectContaining({ task_id: taskId, state: "queued", reason: "handover" })]);
    expect(world.approvals(taskId)).toEqual([expect.objectContaining({ status: "consumed", run_id: world.runs(taskId).at(-1)!.id })]);
    expect(world.calls(CODEX).filter((c) => c.name === "begin_external_op").map((c) => c.result?.status)).toEqual(["pending"]);
    expect(world.externalOps(taskId)).toEqual([expect.objectContaining({ action: "send_email", status: "done" })]);
    expect(world.task(taskId).state).toBe("ready_for_review");
  });

  it("a decision that lands between the claim and the first read does not leave the new run waiting", async () => {
    const world = createStubWorld();
    const taskId = world.human.createTask({ title: "Email", delegate: CLAUDE_CODE });
    const page = String(world.task(taskId).row_page_id);
    const closeA = new AbortController();
    world.script(CLAUDE_CODE, "request_approval", 1, () => closeA.abort());
    await runAgent({ mcp: world.client(CLAUDE_CODE), model: createStubModel([
      { tool_calls: [toolCall("request_approval", { action: "send_email", params: { to: "team@example.com" }, question: "Send?" })] },
    ]), clock: fakeClock(), maxTasks: 1, harness: "claude_code", signal: closeA.signal });
    world.human.releaseForHandover(taskId, CODEX);
    world.script(CODEX, "claim_task", 1, () => world.human.decide(world.approvals(taskId)[0].id, "approve"));
    const giveUp = new AbortController();
    world.script(CODEX, "wait_for_task", 20, () => giveUp.abort());
    const modelB = createStubModel([
      { tool_calls: [toolCall("begin_external_op", { provider: "smtp", action: "send_email", params: { to: "team@example.com" } })] },
      { tool_calls: [toolCall("finish_external_op", { op_id: "op-1", status: "done", provider_ref: "msg-1" })] },
      { tool_calls: [toolCall("add_artifact", { kind: "page", ref: page, title: "Email", satisfies: [] })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Sent", artifact_ids: ["art-1"] })] },
    ]);
    const b = await runAgent({ mcp: world.client(CODEX), model: modelB, clock: fakeClock(), maxTasks: 1, harness: "codex", signal: giveUp.signal });
    expect(b.tasks[0].outcome).toBe("submitted");
    expect(String(modelB.requests[0].messages.at(-1)?.content)).toContain("decided right after you claimed");
    expect(world.approvals(taskId)).toEqual([expect.objectContaining({ status: "consumed" })]);
  });

  it("after a delivery, the same agent's next run is not guarded by the delivered writes and records no handover", async () => {
    const world = createStubWorld();
    const task = world.human.createTask({ title: "Sources", delegate: CODEX });
    const page = String(world.task(task).row_page_id);
    world.script(CODEX, "submit_for_review", 1, () => world.human.feedback(task, "Write the sources again, with links"));
    const model = createStubModel([
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "## Sources" })] },
      { tool_calls: [toolCall("add_artifact", { kind: "page", ref: page, title: "Sources", satisfies: [] })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Done", artifact_ids: ["art-1"] })] },
      { tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "## Sources" })] },
      { tool_calls: [toolCall("submit_for_review", { summary: "Done again", artifact_ids: ["art-1"] })] },
    ]);
    const out = await runAgent({ mcp: world.client(CODEX), model, clock: fakeClock(), maxTasks: 2, harness: "codex" });
    expect(out.tasks.map((t) => t.outcome)).toEqual(["submitted", "submitted"]);
    expect(world.calls(CODEX).filter((c) => c.name === "claim_task").map((c) => c.args.resume)).toEqual([true, true]);
    expect(world.calls(CODEX).filter((c) => c.name === "append_blocks")).toHaveLength(2);
    expect(toolMessages(model).join("\n")).not.toContain("already_done");
    expect(world.activities(task).filter((a) => a.type === "handover")).toHaveLength(0);
  });

  it("a lost write response is retried once with the same idempotency key and lands once", async () => {
    const world = createStubWorld();
    const task = world.human.createTask({ title: "Retry", delegate: CLAUDE_CODE });
    const page = String(world.task(task).row_page_id);
    world.faults.loseResponses(CLAUDE_CODE, "append_blocks", { count: 1 });
    const model = createStubModel([{ tool_calls: [toolCall("append_blocks", { page_id: page, markdown: "Once" })] }]);
    await runAgent({ mcp: world.client(CLAUDE_CODE), model, clock: fakeClock(), maxTasks: 1, harness: "claude_code" });
    const writes = world.calls(CLAUDE_CODE).filter((c) => c.name === "append_blocks");
    expect(writes.map((c) => c.outcome)).toEqual(["lost", "ok"]);
    expect(writes[0].args.idempotency_key).toBe(writes[1].args.idempotency_key);
    expect(writes[0].args.idempotency_key).toBeTruthy();
    expect(world.blocks(page)).toHaveLength(1);
    expect(toolMessages(model).join("\n")).not.toContain("error");
  });
});
