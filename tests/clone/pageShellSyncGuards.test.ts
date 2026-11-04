// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import { PageSyncEngine, flush, forceFullPush, initSync, stopSync, useSyncConflict, useSyncStatus } from "@/lib/sync";
import { MemoryQueue } from "@/lib/opsQueue";
import * as pageOps from "@/lib/pageOps";
import type { PageOp } from "@/lib/pageOps";
import { isShell, shellOf } from "@/lib/pageShell";
import { pageRecoveryCopies, savePageRecovery, useBlockConflicts, usePageRecoveries } from "@/lib/syncConflicts";
import { useStore } from "@/lib/store";
import { applyingExternal } from "@/lib/externalApply";
import { clearHistory, initHistory, undo } from "@/lib/history";
import { claimWorkspace, openLocalDb, readWorkspace } from "@/lib/localDb";
import { fullWrite, startWriter, stopLocalPersistence } from "@/lib/localPersistence";
import type { PageRow } from "@/lib/syncMerge";
import type { Page } from "@/lib/types";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, db, page, prop, row, T } from "./fixtures";

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => h.client, isSupabaseConfigured: () => !!h.client }));
vi.mock("@/lib/fileStore", async (original) => ({ ...await original<typeof import("@/lib/fileStore")>(), onFileSyncStart: () => {}, onFileSyncStop: () => {}, hasPendingUploads: () => false }));
const full = () => page({ id: "p", revision: 4, blocks: [b("paragraph", { id: "block", html: "Keep this body", rev: 1 })] });
const conflict = { code: "PT409", message: "page_conflict" };
const tree = (patch: Partial<Extract<PageOp, { op: "set_tree" }>> = {}): PageOp => ({ op: "set_tree", parentId: "destination", isDeleted: false, ...patch });
function engineFixture() {
  let server: Page | null = full(), local = shellOf(full());
  const queue = new MemoryQueue(), events: string[] = []; queue.setRevision("p", 4);
  const read = vi.fn(async (): Promise<PageRow | null> => server ? { id: "p", revision: server.revision!, data: server, deleted_at: null, updated_at: new Date(T).toISOString() } : null);
  const send = vi.fn(async (_id: string, ops: PageOp[]) => {
    expect(ops.some((op) => op.op === "set_tree")).toBe(false);
    for (const op of ops) if (op.op === "replace_page") { expect(isShell(op.page)).toBe(false); if (op.revision !== server?.revision) throw conflict; }
    const result = pageOps.applyOps(server!, ops, { by: "human", id: "owner", at: T });
    server = { ...result.page, revision: server!.revision! + 1 };
    return { revision: server.revision!, results: result.results };
  });
  const apply = vi.fn((_id: string, p: Page | null) => { if (p) local = p; });
  const pageConflict = vi.fn((_id: string, p: Page) => { events.push("recovery"); savePageRecovery("owner", p); });
  const engine = new PageSyncEngine(queue, "client", { by: "human", id: "owner", at: T }, { getPage: () => local, apply, send, read, conflict: () => {}, pageConflict });
  return { queue, engine, read, send, apply, pageConflict, events, local: () => local, server: () => server, setLocal: (p: Page) => { local = p; }, setServer: (p: Page | null) => { server = p; } };
}
beforeEach(() => { installFakeIndexedDb(); localStorage.clear(); sessionStorage.clear(); h.client = null; useBlockConflicts.setState({ byPage: {}, pageReloads: {} }); usePageRecoveries.setState({ copies: {}, errors: {} }); });
afterEach(() => { stopSync(); stopLocalPersistence(); clearHistory(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("rejects unloaded full replacements before queue mutation", () => {
  const queue = new MemoryQueue();
  expect(() => queue.enqueue("p", [{ op: "set_page", patch: { title: "safe" } }, { op: "replace_page", page: shellOf(full()), revision: 4 }])).toThrow("replace_page_needs_a_body");
  expect(queue.peek("p")).toEqual([]);
});
it("diffs shell tree metadata and applies rowOrigin removal without reading a body", () => {
  const before = shellOf(full()), origin = { databasePageId: "database", index: 2, row: row({ files: ["attachment"] }, "p") };
  const after = { ...before, title: "Renamed", parentId: "destination", isDeleted: true, rowOrigin: origin };
  const ops = pageOps.shellOps(before, after);
  expect(ops).toEqual([{ op: "set_page", patch: { title: "Renamed" } }, { op: "set_tree", parentId: "destination", isDeleted: true, rowOrigin: origin }]);
  const applied = pageOps.applyOps(full(), ops, { by: "human", id: "owner", at: T }).page;
  expect(applied.blocks).toEqual(full().blocks); expect(applied.rowOrigin).toEqual(origin);
  expect(pageOps.applyOps(applied, [tree({ rowOrigin: undefined })], { by: "human", id: "owner", at: T }).page.rowOrigin).toBeUndefined();
});
it("sends tree changes as full revision-checked server bodies and advances following replacements", async () => {
  const s = engineFixture(), origin = { databasePageId: "db", index: 1, row: row({ text: "retained" }, "p") };
  s.queue.enqueue("p", [tree({ isDeleted: true, rowOrigin: origin }), { op: "replace_page", page: { ...full(), title: "After tree" }, revision: 4 }]);
  await s.engine.flushPage("p");
  expect(s.send.mock.calls[0][1]).toEqual([{ op: "replace_page", page: { ...full(), parentId: "destination", isDeleted: true, rowOrigin: origin }, revision: 4 }]);
  expect(s.send.mock.calls[1][1][0]).toMatchObject({ op: "replace_page", revision: 5 });
  expect(s.server()?.blocks).toEqual(full().blocks); expect(s.queue.peek("p")).toEqual([]);
});
it("sends preceding operations before a tree change and reads the resulting server body", async () => {
  const s = engineFixture(); s.queue.enqueue("p", [{ op: "update_block", id: "block", patch: { html: "Edited first" } }, tree()]);
  await s.engine.flushPage("p");
  expect(s.send.mock.calls.map(([, ops]) => ops.map((op) => op.op))).toEqual([["update_block"], ["replace_page"]]);
  expect(s.server()?.blocks[0].html).toBe("Edited first");
});
it("retries tree conflicts at most three times then notifies before acknowledging, without empty rescue copies", async () => {
  const s = engineFixture(); s.queue.enqueue("p", [tree()]);
  const ack = s.queue.ack.bind(s.queue); vi.spyOn(s.queue, "ack").mockImplementation((id, count) => { s.events.push("ack"); ack(id, count); });
  s.send.mockRejectedValue(conflict); await s.engine.flushPage("p");
  expect(s.send).toHaveBeenCalledTimes(3); expect(s.events).toEqual(["recovery", "ack"]);
  expect(pageRecoveryCopies("owner", "p")).toBeUndefined(); expect(useBlockConflicts.getState().pageReloads.p).toBeDefined();
  expect(s.server()?.blocks[0].html).toBe("Keep this body");
});
it("reads a fresh revision for each tree retry and acknowledges a vanished page", async () => {
  const s = engineFixture(); s.queue.enqueue("p", [tree()]);
  s.send.mockImplementationOnce(async () => { s.setServer({ ...full(), revision: 5 }); throw conflict; });
  await s.engine.flushPage("p"); expect(s.send.mock.calls[1][1][0]).toMatchObject({ revision: 5 });
  s.queue.enqueue("p", [tree()]); s.setServer(null); await s.engine.flushPage("p"); expect(s.queue.peek("p")).toEqual([]);
});
it("never advances body revision or applies pending changes to metadata-only receives, including own echoes", () => {
  const s = engineFixture(), setRevision = vi.spyOn(s.queue, "setRevision");
  const meta: PageRow = { id: "p", data: { ...shellOf(full()), _client: "client" }, revision: 8, updated_at: new Date(T).toISOString(), deleted_at: null };
  s.engine.receive(meta); expect(setRevision).not.toHaveBeenCalled(); expect(s.apply).toHaveBeenCalledWith("p", expect.anything(), false);
  s.apply.mockClear(); s.queue.enqueue("p", [tree()]); s.engine.receive(meta, true); expect(s.apply).not.toHaveBeenCalled();
  s.queue.markDeleted("p"); s.engine.receive(meta, true); expect(s.apply).not.toHaveBeenCalled(); expect(s.queue.getRevision("p")).toBe(4);
});
it("rescues the rejected full replacement when memory only has metadata", async () => {
  const s = engineFixture(), rejected = { ...full(), blocks: [b("paragraph", { html: "Unsynced layout" })] };
  s.queue.enqueue("p", [{ op: "replace_page", page: rejected, revision: 3 }]); await s.engine.flushPage("p");
  expect(pageRecoveryCopies("owner", "p")?.[0].page.blocks[0].html).toBe("Unsynced layout");
});
it("rescues the newest queued replacement and later edits when memory only has metadata", async () => {
  const s = engineFixture(), newest = { ...full(), title: "Newest layout" };
  s.queue.enqueue("p", [{ op: "replace_page", page: full(), revision: 3 }, { op: "replace_page", page: newest, revision: 3 }, { op: "update_block", id: "block", patch: { html: "Later draft" } }]);
  await s.engine.flushPage("p");
  expect(pageRecoveryCopies("owner", "p")?.[0].page).toMatchObject({ title: "Newest layout", blocks: [{ html: "Later draft" }] });
});
it("retains rejected operations if saving the full recovery fails", async () => {
  const s = engineFixture(); s.queue.enqueue("p", [{ op: "replace_page", page: full(), revision: 3 }]);
  s.pageConflict.mockImplementation(() => { throw new Error("quota"); });
  await expect(s.engine.flushPage("p")).rejects.toThrow("quota"); expect(s.queue.peek("p")).toHaveLength(1);
});
it("does not write a shell to localStorage recovery", () => {
  const write = vi.spyOn(Storage.prototype, "setItem"); savePageRecovery("owner", shellOf(full()));
  expect(write).not.toHaveBeenCalled(); expect(useBlockConflicts.getState().pageReloads.p).toBeDefined();
});

function backend(rows: PageRow[], duringInsert?: () => void) {
  const sent: PageOp[][] = [], sentIds: string[] = [], inserted: Page[] = [];
  const workspace = { id: "ws", owner_id: "owner", name: "Workspace", root_order: ["p"], synced_blocks: {}, settings: {}, revision: 1, updated_at: new Date(T).toISOString() };
  const from = (table: string) => {
    let id: string | null = null, created: unknown;
    const data = () => created ? [created] : table === "workspaces" ? [workspace] : table === "pages" ? rows.filter((r) => !id || r.id === id) : [];
    const builder: unknown = new Proxy({}, { get: (_, key) => {
      if (key === "then") return (resolve: (value: unknown) => void) => resolve({ data: data(), error: null });
      if (key === "single" || key === "maybeSingle") return async () => ({ data: data()[0] ?? null, error: null });
      if (key === "eq") return (column: string, value: string) => { if (column === "id") id = value; return builder; };
      if (key === "insert") return (value: { id: string; data: Page }) => {
        if (table === "pages") { duringInsert?.(); inserted.push(value.data); const row = { id: value.id, data: value.data, revision: 1, deleted_at: null, updated_at: new Date(T).toISOString() }; rows.push(row); created = row; }
        return builder;
      };
      return () => builder;
    } }); return builder;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  h.client = { from, channel: () => channel, removeChannel: async () => {}, getChannels: () => [], rpc: async (name: string, args: { p_page_id: string; p_ops: PageOp[]; p_client?: string }) => {
    if (name === "read_workspace_synced_blocks") return { data: {}, error: null };
    if (name === "apply_page_ops") { sent.push(args.p_ops); sentIds.push(args.p_page_id); const row = rows.find((r) => r.id === args.p_page_id)!; if (row.data && args.p_ops.some((op) => op.op === "replace_page" && op.revision !== row.revision)) return { data: null, error: { code: "PT409", message: "page_conflict" } }; const applied = pageOps.applyOps(row.data ?? page({ id: row.id, blocks: [] }), args.p_ops, { by: "human", id: "owner", at: T }); row.data = { ...applied.page, _client: args.p_client }; row.revision++; return { data: { revision: row.revision, results: applied.results }, error: null }; }
    return { data: { revision: 1, results: [] }, error: null };
  } };
  return { sent, sentIds, inserted };
}
async function diskPage(content: Page | null = full()) {
  const db = await openLocalDb(); await claimWorkspace(db, content ? [fullWrite(content)] : [], [], null);
  startWriter(db, (await readWorkspace(db)).epoch);
  applyingExternal(() => useStore.setState({ pages: { p: shellOf(content ?? full()) }, rootOrder: ["p"], syncedBlocks: {}, reminders: [], syncUserId: "owner", syncWorkspaceId: "ws" }));
}
const serverRow = (): PageRow => ({ id: "p", data: full(), revision: 4, deleted_at: null, updated_at: new Date(T).toISOString() });
it("inserts a local-only shell using the stored body and latest in-memory metadata", async () => {
  const unsynced = { ...full(), revision: undefined }; await diskPage(unsynced); const cloud = backend([]);
  applyingExternal(() => useStore.setState({ pages: { p: { ...shellOf(unsynced), title: "Latest metadata" } } }));
  await initSync({ id: "owner" } as User);
  expect(cloud.inserted).toHaveLength(1); expect(isShell(cloud.inserted[0])).toBe(false);
  expect(cloud.inserted[0]).toMatchObject({ title: "Latest metadata", blocks: [{ html: "Keep this body" }] });
});
it("does not insert a shell whose body is unavailable", async () => {
  await diskPage(null); applyingExternal(() => useStore.setState({ pages: { p: shellOf({ ...full(), revision: undefined }) } }));
  const cloud = backend([]); await initSync({ id: "owner" } as User); await flush();
  expect(cloud.inserted).toEqual([]); expect(useSyncStatus.getState().status).toBe("error");
});
it("full push loads stored bodies and preserves cloud pages whose local body is missing", async () => {
  await diskPage(); const rows = [serverRow()], cloud = backend(rows); await initSync({ id: "owner" } as User);
  applyingExternal(() => useStore.setState({ pages: { p: shellOf(full()), missing: shellOf(page({ ...full(), id: "missing" })) } }));
  rows.push({ ...serverRow(), id: "missing", data: page({ ...full(), id: "missing" }) });
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
  await forceFullPush();
  const replacements = cloud.sent.flat().filter((op) => op.op === "replace_page");
  expect(replacements).toHaveLength(1); expect(isShell(replacements[0].page)).toBe(false);
  expect(rows.find((r) => r.id === "missing")?.data?.blocks[0].html).toBe("Keep this body");
  expect(cloud.sent.flat().filter((op) => op.op === "set_tree")).toEqual([]);
});
it("loads full bodies for Keep local rather than enqueuing shells", async () => {
  await diskPage(); const cloud = backend([serverRow()]);
  applyingExternal(() => useStore.setState({ syncWorkspaceId: null, pages: { p: { ...shellOf(full()), updatedAt: T + 1 } } }));
  const boot = initSync({ id: "owner" } as User);
  for (let i = 0; i < 80 && !useSyncConflict.getState().prompt; i++) await Promise.resolve();
  expect(useSyncConflict.getState().prompt).not.toBeNull(); useSyncConflict.getState().prompt!.resolve("local");
  await boot; await flush();
  expect(cloud.sent.flat()).toContainEqual(expect.objectContaining({ op: "replace_page", page: expect.objectContaining({ blocks: [expect.objectContaining({ html: "Keep this body" })] }) }));
});
it("queues tree changes and imports, but never queues an external body load", async () => {
  await diskPage(); backend([serverRow()]); await initSync({ id: "owner" } as User);
  applyingExternal(() => useStore.setState({ pages: { p: shellOf(full()), destination: page({ id: "destination" }) } }));
  const enqueue = vi.spyOn(MemoryQueue.prototype, "enqueue");
  useStore.getState().movePage("p", "destination"); useStore.getState().deletePage("p");
  expect(enqueue).toHaveBeenCalledWith("p", [{ op: "set_tree", parentId: "destination", isDeleted: false, rowOrigin: undefined }]);
  expect(enqueue).toHaveBeenCalledWith("p", [{ op: "set_tree", parentId: "destination", isDeleted: true, rowOrigin: undefined }]);
  enqueue.mockClear(); applyingExternal(() => useStore.setState({ pages: { p: full() } }));
  expect(enqueue).not.toHaveBeenCalled();
  applyingExternal(() => useStore.setState({ pages: { p: shellOf(full()) } }));
  useStore.setState({ pages: { p: { ...full(), title: "Imported" } } });
  expect(enqueue).toHaveBeenCalledWith("p", [{ op: "replace_page", page: expect.objectContaining({ title: "Imported", blocks: [expect.objectContaining({ html: "Keep this body" })] }), revision: 4 }]);
});
it("a replacement built from undo history carries the revision this client already acknowledged", async () => {
  await diskPage(); const rows = [serverRow()]; backend(rows); await initSync({ id: "owner" } as User);
  applyingExternal(() => useStore.setState({ pages: { p: full(), destination: page({ id: "destination" }) } }));
  initHistory(); clearHistory();
  useStore.getState().updatePage("p", { title: "Edited here" }); await flush();
  useStore.getState().movePage("p", "destination"); await flush();
  expect(rows[0]).toMatchObject({ revision: 6, data: expect.objectContaining({ parentId: "destination" }) });
  // The undo snapshot predates this client's own acknowledged writes; the server only has those.
  undo(); await flush();
  expect(rows[0]).toMatchObject({ revision: 7, data: expect.objectContaining({ parentId: null }) });
  expect(pageRecoveryCopies("owner", "p") ?? []).toEqual([]);
});
it("a replacement queued while the page insert is in flight carries the inserted revision", async () => {
  await diskPage(); const rows = [serverRow()];
  const cloud = backend(rows, () => useStore.getState().movePage("fresh", "p"));
  await initSync({ id: "owner" } as User);
  applyingExternal(() => useStore.setState({ pages: { p: full(), fresh: { ...page({ id: "fresh", blocks: [b("paragraph", { id: "fb", html: "Fresh", rev: 1 })] }), revision: undefined } } }));
  await flush();
  expect(cloud.inserted.map((p) => p.id)).toEqual(["fresh"]);
  expect(rows.find((r) => r.id === "fresh")).toMatchObject({ revision: 2, data: expect.objectContaining({ parentId: "p" }) });
  expect(pageRecoveryCopies("owner", "fresh") ?? []).toEqual([]);
});
it("loads the stored body when merging a newer local page over a server tombstone", async () => {
  await diskPage(); applyingExternal(() => useStore.setState({ pages: { p: { ...shellOf(full()), updatedAt: T + 10 } } }));
  const cloud = backend([{ ...serverRow(), data: null, deleted_at: new Date(T).toISOString() }]);
  await initSync({ id: "owner" } as User); await flush();
  expect(cloud.sent.flat()).toContainEqual(expect.objectContaining({ op: "replace_page", page: expect.objectContaining({ blocks: [expect.objectContaining({ html: "Keep this body" })] }) }));
});
it("leaves a missing-body block conflict pending and reports unavailable once", async () => {
  vi.stubGlobal("alert", vi.fn()); applyingExternal(() => useStore.setState({ pages: { p: shellOf(full()) } }));
  useBlockConflicts.getState().add("p", { id: "block", theirs: b("paragraph", { html: "Other" }), at: T });
  useBlockConflicts.getState().resolve("p", "block", "theirs");
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(window.alert).toHaveBeenCalledTimes(1); expect(isShell(useStore.getState().pages.p)).toBe(true);
  expect(useBlockConflicts.getState().byPage.p).toHaveLength(1);
});
it("saves a shell row's archive before removing its database reference and restores its cells on undo", async () => {
  const rowPage = { ...full(), parentId: "db" }, entry = row({ files: [{ fileId: "attachment" }] }, "p");
  const database = page({ id: "db", revision: 4, database: db([prop({ id: "files", type: "files" })], [entry]) });
  await diskPage(rowPage);
  applyingExternal(() => useStore.setState({ pages: { p: shellOf(rowPage), db: database }, rootOrder: ["db"] }));
  const rows = [{ ...serverRow(), data: rowPage }, { ...serverRow(), id: "db", data: database }], cloud = backend(rows);
  await initSync({ id: "owner" } as User);
  applyingExternal(() => useStore.setState(({ pages }) => ({ pages: { ...pages, p: shellOf(rowPage) } })));
  initHistory(); clearHistory(); useStore.getState().deleteRow("db", entry.id); await flush();
  expect(cloud.sentIds.slice(0, 2)).toEqual(["p", "db"]);
  expect(rows[0].data).toMatchObject({ blocks: [{ html: "Keep this body" }], rowOrigin: { row: { cells: entry.cells } } });
  expect(rows[1].data.database?.rows).toEqual([]);
  undo(); await flush();
  expect(rows[0].data.rowOrigin).toBeUndefined(); expect(rows[0].data.blocks[0].html).toBe("Keep this body");
  expect(rows[1].data.database?.rows[0].cells).toEqual(entry.cells);
});
