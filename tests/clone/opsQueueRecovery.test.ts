// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PageOp } from "@/lib/pageOps";
import type { IndexedDbQueue } from "@/lib/opsQueue";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { T } from "./fixtures";

let fake: ReturnType<typeof installFakeIndexedDb>;
let queue: IndexedDbQueue;
const A: PageOp = { op: "set_page", patch: { title: "A" } };
const B: PageOp = { op: "set_page", patch: { title: "B" } };
beforeEach(async () => {
  vi.resetModules(); localStorage.clear(); fake = installFakeIndexedDb();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const queues = await import("@/lib/opsQueue");
  queue = new queues.IndexedDbQueue("account-a:ws-a", "tab", { retryDelaysMs: [0, 0, 0] });
  await queue.ready;
});
afterEach(async () => { await queue.close().catch(() => {}); vi.restoreAllMocks(); });
function storedOps() {
  return fake.dump("ops").map((value) => (value as { entries: { op: PageOp }[] }).entries.map((entry) => entry.op));
}

it("OQ-1 a failed write does not block the writes that follow", async () => {
  fake.failNext("QuotaExceededError", 3);
  queue.enqueue("p", [A]); queue.enqueue("p", [B]);
  await queue.settled();
  expect(storedOps()).toEqual([[A, B]]);
});

it("OQ-2 a transient failure is retried with the current state", async () => {
  fake.failNext("AbortError", 1);
  queue.enqueue("p", [A]); await queue.settled();
  expect(storedOps()).toEqual([[A]]);
  expect(queue.storageState()).toEqual({ degraded: false, stalePages: [] });
});

it("OQ-3 exhausted retries report degraded and the next good write heals it", async () => {
  fake.failNext("QuotaExceededError", 3);
  queue.enqueue("p", [A]); await queue.settled();
  expect(queue.storageState()).toEqual({ degraded: true, stalePages: ["p"] });
  expect(console.warn).toHaveBeenCalledTimes(1);
  queue.enqueue("p", [B]); await queue.settled();
  expect(queue.storageState()).toEqual({ degraded: false, stalePages: [] });
  expect(storedOps()).toEqual([[A, B]]);
  expect(console.warn).toHaveBeenCalledTimes(2);
});

it("OQ-4 a reload after a healed failure sees each pending op once", async () => {
  fake.failNext("QuotaExceededError", 3);
  queue.enqueue("p", [A]); queue.enqueue("p", [B]); await queue.settled(); await queue.close();
  const queues = await import("@/lib/opsQueue");
  const again = new queues.IndexedDbQueue("account-a:ws-a", "tab");
  await again.ready;
  try { expect(again.peek("p")).toEqual([A, B]); } finally { await again.close(); }
});

it("OQ-5 the sync engine keeps sending while the local copy keeps failing", async () => {
  const { PageSyncEngine } = await import("@/lib/sync");
  const sendCalls: PageOp[][] = [];
  const engine = new PageSyncEngine(queue, "client", { by: "human", id: "client", at: T }, {
    getPage: () => undefined, apply: () => {}, read: async () => null,
    conflict: () => {}, pageConflict: () => {},
    send: async (_id, ops) => { sendCalls.push(ops); return { revision: 2, results: ops.map((_, i) => ({ i, ok: true })) }; },
  });
  fake.failNext("QuotaExceededError", 30);
  queue.setRevision("p", 1);
  queue.enqueue("p", [{ op: "update_block", id: "a", rev: 1, patch: { html: "First" } }]);
  await expect(engine.flushPage("p")).resolves.toBeUndefined();
  expect(sendCalls).toHaveLength(1); expect(queue.peek("p")).toEqual([]);
  expect(queue.storageState().degraded).toBe(true);
});
