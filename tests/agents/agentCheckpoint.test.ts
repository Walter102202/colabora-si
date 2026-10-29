import { describe, expect, it } from "vitest";
import { argsHash, buildCheckpoint, guardFor, guardsFromResume, handoverText, parseCheckpoint, WRITE_TOOLS } from "../../agent/checkpoint.mjs";

const op = (key: string, tool = "append_blocks", args: Record<string, unknown> = { page_id: "p1", markdown: key }) =>
  ({ key, tool, summary: `wrote ${key}`, page_id: "p1", args_hash: argsHash(tool, args) });

describe("runtime checkpoints", () => {
  it("argsHash ignores run_id, idempotency_key and key order", () => {
    expect(argsHash("append_blocks", { page_id: "p1", markdown: "A", run_id: "r1", idempotency_key: "k1" }))
      .toBe(argsHash("append_blocks", { markdown: "A", page_id: "p1" }));
    expect(argsHash("append_blocks", { page_id: "p1", markdown: "A" })).not.toBe(argsHash("edit_page", { page_id: "p1", markdown: "A" }));
    expect(WRITE_TOOLS.has("add_comment")).toBe(false);
  });
  it("buildCheckpoint writes a v1 body with confirmed and pending writes", () => {
    const body = buildCheckpoint({ nextStep: "Email the team", confirmed: [op("k1")], pending: [op("k2")],
      effects: { confirmed: [], not_executed: [{ action: "send_email", approval_id: "ap-1" }], unknown: [] }, evidence: [] });
    expect(body).toMatchObject({ v: 1, next_step: "Email the team", ops: { confirmed: [{ key: "k1" }], pending: [{ key: "k2" }] } });
    expect(Object.keys(body).sort()).toEqual(["effects", "evidence", "next_step", "ops", "v"]);
  });
  it("buildCheckpoint caps lists and text to the server limits", () => {
    const many = Array.from({ length: 250 }, (_, i) => op(`k${i}`));
    const body = buildCheckpoint({ nextStep: "x".repeat(3000), confirmed: many, pending: [], effects: { confirmed: [], not_executed: [], unknown: [] },
      evidence: [], handoverNote: "y".repeat(5000) }) as { ops: { confirmed: { key: string }[] }; next_step: string; handover_note: string };
    expect(body.ops.confirmed).toHaveLength(200);
    expect(body.ops.confirmed[0].key).toBe("k50");      // keeps the most recent 200
    expect(body.next_step).toHaveLength(2000);
    expect(body.handover_note).toHaveLength(4000);
    const heavy = Array.from({ length: 200 }, (_, i) => ({ ...op(`h${i}`), block_ids: Array.from({ length: 200 }, (_, j) => `${i}-${j}`.padEnd(64, "x")) }));
    const capped = buildCheckpoint({ nextStep: "x", confirmed: heavy, pending: [], effects: { confirmed: [], not_executed: [], unknown: [] }, evidence: [] });
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(200_000);   // under the server's 256 KB cap
  });
  it("parseCheckpoint reads v1, flags a newer version and rejects a malformed body", () => {
    expect(parseCheckpoint({ v: 1, next_step: "a" }).status).toBe("ok");
    expect(parseCheckpoint({ v: 2, next_step: "a" })).toEqual({ status: "newer_schema", version: 2 });
    expect(parseCheckpoint({ next_step: "a" }).status).toBe("invalid");
    expect(parseCheckpoint(null).status).toBe("invalid");
  });
  it("guards: confirmed writes are already_done, unknown ones ask to verify first, not_executed ones pass", () => {
    const resume = {
      checkpoint: { readable: true, body: { v: 1, next_step: "a", ops: { confirmed: [op("k1")], pending: [] } } },
      pending_ops: [{ ...op("k2"), status: "confirmed" }, { ...op("k3"), status: "unknown" }, { ...op("k4"), status: "not_executed" }],
    };
    const guards = guardsFromResume(resume);
    expect(guardFor("append_blocks", { page_id: "p1", markdown: "k1" }, guards)?.error).toBe("already_done");
    expect(guardFor("append_blocks", { page_id: "p1", markdown: "k2", idempotency_key: "new" }, guards)?.error).toBe("already_done");
    expect(guardFor("append_blocks", { page_id: "p1", markdown: "k3" }, guards)?.error).toBe("verify_first");
    expect(guardFor("append_blocks", { page_id: "p1", markdown: "k3" }, guards)).toBeNull();   // verify_first only once
    expect(guardFor("append_blocks", { page_id: "p1", markdown: "k4" }, guards)).toBeNull();
  });
  it("handoverText lists what happened, what did not, what someone else changed and what is pending", () => {
    const text = handoverText({
      from: { harness: "claude_code", run_id: "run-1" }, summary: "Continuing from checkpoint #4 by claude_code.",
      checkpoint: { readable: true, body: { v: 1, next_step: "Email the team", handover_note: "Closing the laptop", ops: { confirmed: [op("k1")], pending: [] } } },
      pending_ops: [{ ...op("k2"), status: "confirmed" }], blocks: [{ page_id: "p1", block_id: "blk-1", changed_by_other: true }],
      approvals: [{ id: "ap-1", action: "send_email", status: "pending" }],
    });
    for (const s of ["claude_code", "Email the team", "Closing the laptop", "wrote k1", "wrote k2", "blk-1", "send_email"]) expect(text).toContain(s);
    expect(handoverText({ from: null, checkpoint: null })).toBe("");
    expect(handoverText({ from: { harness: "x" }, checkpoint: { readable: false, version: 2 } })).toMatch(/newer format \(v2\)/);
  });
});
