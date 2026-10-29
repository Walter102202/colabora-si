import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as supabase from "@/lib/supabase";
import { pushSharedPage } from "@/lib/shares";
import { PageSyncEngine } from "@/lib/sync";
import { MemoryQueue } from "@/lib/opsQueue";
import { applyOps, type PageOp } from "@/lib/pageOps";
import type { Page } from "@/lib/types";
import type { BlockConflict } from "@/lib/syncConflicts";
import type { PageRow } from "@/lib/syncMerge";
import { b, page, T } from "./fixtures";

function setup() {
  let server = page({ id: "p", blocks: [b("paragraph", { id: "a", html: "A", rev: 1 }), b("paragraph", { id: "b", html: "B", rev: 1 })], revision: 1 });
  let clientTag = "server";
  const calls: PageOp[][] = [];
  const row = (): PageRow => ({ id: "p", data: { ...server, _client: clientTag }, updated_at: new Date(T + server.revision!).toISOString(), deleted_at: null, revision: server.revision! });
  const send = async (_id: string, ops: PageOp[], tag: string) => {
    if (ops.some((op) => op.op === "replace_page" && op.revision !== server.revision)) throw { code: "PT409", message: "page_conflict" };
    calls.push(ops); const result = applyOps(server, ops, { by: "human", id: tag, at: T });
    server = { ...result.page, revision: server.revision! + 1 }; clientTag = tag;
    return { revision: server.revision!, results: result.results };
  };
  const client = (tag: string) => {
    let local: Page | null = structuredClone(server), applies = 0;
    const queue = new MemoryQueue(), conflicts: BlockConflict[] = [], conflictsPage: string[] = [];
    queue.setRevision("p", 1);
    const engine = new PageSyncEngine(queue, tag, { by: "human", id: tag, at: T }, {
      getPage: () => local ?? undefined, apply: (_id, value) => { local = value; applies++; }, send, read: async () => row(), conflict: (_id, conflict) => conflicts.push(conflict), pageConflict: (id) => { conflictsPage.push(id); },
    });
    const edit = (ops: PageOp[]) => { queue.enqueue("p", ops); local = applyOps(local!, ops, { by: "human", id: tag, at: T }).page; };
    return { engine, queue, conflicts, edit, local: () => local!, applies: () => applies, pageConflicts: () => conflictsPage };
  };
  return { client, row, calls, server: () => server, send };
}
it("SE-1 different blocks converge in both clients", async () => {
  const s = setup(), a = s.client("one"), b = s.client("two");
  a.edit([{ op: "update_block", id: "a", rev: 1, patch: { html: "First" } }]);
  b.edit([{ op: "update_block", id: "b", rev: 1, patch: { html: "Second" } }]);
  await a.engine.flushPage("p"); await b.engine.flushPage("p"); a.engine.receive(s.row());
  for (const client of [a, b]) { expect(client.local().blocks.map((block) => block.html)).toEqual(["First", "Second"]); expect(client.conflicts).toEqual([]); }
});
it("SE-2 same block returns displaced content", async () => {
  const s = setup(), a = s.client("one"), b = s.client("two");
  a.edit([{ op: "update_block", id: "a", rev: 1, patch: { html: "First" } }]);
  b.edit([{ op: "update_block", id: "a", rev: 1, patch: { html: "Second" } }]);
  await a.engine.flushPage("p"); await b.engine.flushPage("p");
  expect(b.conflicts).toMatchObject([{ id: "a", theirs: { html: "First" }, by: { id: "one" } }]);
});
it("SE-3 rebase preserves all three pending operations and remote block", async () => {
  const s = setup(), local = s.client("one");
  local.edit([1, 2, 3].map((n) => ({ op: "insert_block", after: n === 1 ? "b" : `local-${n - 1}`, block: b("paragraph", { id: `local-${n}`, html: String(n) }) })));
  await s.send("p", [{ op: "insert_block", after: "a", block: b("paragraph", { id: "remote", html: "Remote" }) }], "other");
  local.engine.receive(s.row()); expect(local.queue.peek("p")).toHaveLength(3);
  expect(local.local().blocks.map((b) => b.id)).toEqual(["a", "remote", "b", "local-1", "local-2", "local-3"]);
  await local.engine.flushPage("p"); expect(local.queue.peek("p")).toHaveLength(0);
  expect(s.server().blocks.map((b) => b.id)).toEqual(local.local().blocks.map((b) => b.id));
});
it("SE-4 own echo advances revision without applying", () => {
  const s = setup(), local = s.client("one"), row = s.row(); row.revision = 2; row.data!._client = "one";
  expect(local.engine.receive(row)).toBe(false); expect(local.applies()).toBe(0); expect(local.queue.getRevision("p")).toBe(2);
});
it("SE-5 three hundred operations use two ordered batches", async () => {
  const s = setup(), local = s.client("one");
  local.edit(Array.from({ length: 300 }, (_, i) => ({ op: "insert_block", after: i ? `new-${i - 1}` : "b", block: b("paragraph", { id: `new-${i}` }) })));
  await local.engine.flushPage("p"); expect(s.calls.map((batch) => batch.length)).toEqual([200, 100]);
  expect(s.server().blocks.slice(2).map((b) => b.id)).toEqual(Array.from({ length: 300 }, (_, i) => `new-${i}`));
});
it("SE-6 rebase does not create versions", async () => {
  const s = setup(), local = s.client("one");
  local.edit([1, 2, 3].map((n) => ({ op: "insert_block", after: n === 1 ? "b" : `local-${n - 1}`, block: b("paragraph", { id: `local-${n}`, html: String(n) }) })));
  await s.send("p", [{ op: "insert_block", after: "a", block: b("paragraph", { id: "remote", html: "Remote" }) }], "other");
  local.engine.receive(s.row());
  expect(local.local().versions).toBeUndefined();
});
it("SE-7 a stale replace_page is dropped, the page reloads and the client is told once", async () => {
  const s = setup(), local = s.client("one");
  await s.send("p", [{ op: "update_block", id: "a", patch: { html: "Remote" } }], "other");
  local.edit([{ op: "replace_page", page: { ...local.local(), title: "Mine" }, revision: 1 }]);
  await local.engine.flushPage("p");
  expect(local.queue.peek("p")).toHaveLength(0);
  expect(local.local().title).toBe("Untitled");
  expect(local.local().blocks[0].html).toBe("Remote");
  expect(local.pageConflicts()).toEqual(["p"]);
});
it("SE-8 a replace_page queued behind a full batch is not a conflict", async () => {
  const s = setup(), local = s.client("one");
  local.edit(Array.from({ length: 300 }, (_, i) => ({ op: "insert_block", after: i ? `new-${i - 1}` : "b", block: b("paragraph", { id: `new-${i}` }) })));
  local.edit([{ op: "replace_page", page: { ...local.local(), title: "Mine" }, revision: 1 }]);
  await local.engine.flushPage("p");
  expect(s.server().title).toBe("Mine");
  expect(local.pageConflicts()).toEqual([]);
});
it("SE-9 shared-page transport preserves page conflicts and masks other failures", async () => {
  const conflict = { code: "PT409", message: "page_conflict" };
  const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: conflict }).mockResolvedValueOnce({ data: null, error: { code: "PT403", message: "private details" } });
  const spy = vi.spyOn(supabase, "getSupabase").mockReturnValue({ rpc } as unknown as SupabaseClient);
  try {
    await expect(pushSharedPage("p", [], "client", "key")).rejects.toBe(conflict);
    await expect(pushSharedPage("p", [], "client", "key2")).rejects.toThrow("You no longer have edit access.");
  } finally { spy.mockRestore(); }
});
