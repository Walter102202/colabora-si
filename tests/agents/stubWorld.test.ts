import { describe, expect, it } from "vitest";
import { CLAUDE_CODE, CODEX, createStubWorld } from "../../agent/test/stub-world.mjs";

async function started() {
  const world = createStubWorld();
  const task = world.human.createTask({ title: "Draft", delegate: CLAUDE_CODE });
  const client = world.client(CLAUDE_CODE);
  const claim = await client.callTool("claim_task", { task_id: task, harness: "claude_code", resume: true });
  return { world, task, client, run: claim.data.run_id, page: String(world.task(task).row_page_id) };
}

describe("stateful handover world", () => {
  it("save_checkpoint is ephemeral, hand_over is not, and hand_over detaches the pending approval", async () => {
    const { world, task, client, run } = await started();
    await client.callTool("request_approval", { run_id: run, action: "send_email", params: {}, question: "Send?" });
    const checkpoint = { v: 1, next_step: "Send", handover_note: "Closing" };
    await client.callTool("save_checkpoint", { run_id: run, checkpoint, idempotency_key: "cp" });
    await client.callTool("hand_over", { run_id: run, checkpoint, idempotency_key: "ho" });
    expect(world.activities(task).filter((a) => a.type === "checkpoint").map((a) => a.ephemeral)).toEqual([true, false]);
    expect(world.approvals(task)[0]).toMatchObject({ status: "pending", run_id: null });
  });
  it("a write receipt is per tool, key and agent", async () => {
    const { world, task, client, run, page } = await started();
    const args = { page_id: page, markdown: "One", idempotency_key: "k1" };
    const first = await client.callTool("append_blocks", args);
    const replay = await client.callTool("append_blocks", args);
    expect(replay.data.block_ids).toEqual(first.data.block_ids);
    expect(world.blocks(page)).toHaveLength(1);
    await client.callTool("hand_over", { run_id: run, checkpoint: { v: 1, next_step: "Continue", handover_note: "Closing" }, idempotency_key: "ho" });
    world.human.releaseForHandover(task, CODEX);
    const codex = world.client(CODEX);
    await codex.callTool("claim_task", { task_id: task, harness: "codex", resume: true });
    await codex.callTool("append_blocks", args);
    expect(world.blocks(page)).toHaveLength(2);
  });
  it("a person's edit after the checkpoint is changed_by_other at the next resume claim", async () => {
    const { world, task, client, run, page } = await started();
    const write = await client.callTool("append_blocks", { page_id: page, markdown: "Draft", idempotency_key: "k" });
    const checkpoint = { v: 1, next_step: "Finish", handover_note: "Closing", ops: { confirmed: [{ key: "k", tool: "append_blocks", page_id: page, block_ids: write.data.block_ids }] } };
    await client.callTool("save_checkpoint", { run_id: run, checkpoint, idempotency_key: "cp" });
    await client.callTool("hand_over", { run_id: run, checkpoint, idempotency_key: "ho" });
    world.human.editBlock(page, write.data.block_ids[0], "Ana's draft");
    world.human.releaseForHandover(task, CODEX);
    const claimed = await world.client(CODEX).callTool("claim_task", { task_id: task, harness: "codex", resume: true });
    expect(claimed.data.resume.blocks).toContainEqual(expect.objectContaining({ block_id: write.data.block_ids[0], changed_by_other: true }));
  });
  it("a second claim while the run is active is run_active and adds no handover activity", async () => {
    const { world, task } = await started();
    world.human.releaseForHandover(task, CODEX);
    const args = { task_id: task, harness: "codex", resume: true };
    expect((await world.client(CODEX).callTool("claim_task", args)).isError).toBe(false);
    expect((await world.client(CODEX).callTool("claim_task", args)).data.code).toBe("run_active");
    expect(world.activities(task).filter((a) => a.type === "handover")).toHaveLength(1);
  });
});
