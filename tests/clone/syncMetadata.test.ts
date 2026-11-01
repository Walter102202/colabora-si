// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import type { MemoryQueue } from "@/lib/opsQueue";
import { useStore } from "@/lib/store";
import { applyingExternal } from "@/lib/externalApply";
import { isShell, shellOf } from "@/lib/pageShell";
import { rowFromMeta, type PageMetaRow, type PageRow } from "@/lib/syncMerge";
import { forceFullPull, initSync, PAGE_META_COLS, refreshPageFromCloud, stopSync, useSyncConflict } from "@/lib/sync";
import { ensurePageBody } from "@/lib/pageBodies";
import { claimWorkspace, openLocalDb, readWorkspace } from "@/lib/localDb";
import { fullWrite, flushLocalWrites, forgetLocalBodies, hasPendingLocalWrites, persistFull, readFullWorkspace, readStoredPage, startWriter, stopLocalPersistence } from "@/lib/localPersistence";
import { DEFAULT_SETTINGS } from "@/lib/factories";
import { applyOps, type PageOp } from "@/lib/pageOps";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, db, page, prop, row, T } from "./fixtures";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({ rows: [] as PageRow[], selects: [] as { columns: string; single: boolean }[], changes: new Map<string, (payload: { new: PageRow }) => void>(), subscribe: null as ((status: string) => void) | null, client: null as unknown, queue: null as MemoryQueue | null, initialOps: [] as PageOp[], root: [] as string[], authorized: {}, sent: [] as PageOp[], pauseRead: null as (() => Promise<void>) | null }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => h.client, isSupabaseConfigured: () => true }));
vi.mock("@/lib/opsQueue", async (original) => {
  const actual = await original<typeof import("@/lib/opsQueue")>();
  class Queue extends actual.MemoryQueue { readonly ready = Promise.resolve(); constructor() { super(); h.queue = this; if (h.initialOps.length) this.enqueue("p", h.initialOps); } async close() {} }
  return { ...actual, IndexedDbQueue: Queue, clearStoredOps: async () => {} };
});
vi.mock("@/lib/fileStore", async (original) => ({ ...await original<typeof import("@/lib/fileStore")>(), onFileSyncStart: () => {}, onFileSyncStop: () => {}, hasPendingUploads: () => false, clearLocalFiles: async () => {} }));

function project(source: PageRow): PageMetaRow {
  const { data, ...columns } = source;
  const value: Row = { ...columns, data_id: data?.id ?? null };
  for (const key of ["title", "icon", "cover", "coverPosition", "rowOrigin", "fullWidth", "smallText", "locked", "font", "isFavorite", "isDeleted", "createdAt"] as const) value[key] = data?.[key] ?? null;
  for (const [key, field] of [["dbId", "id"], ["dbProperties", "properties"], ["dbViews", "views"], ["dbLocked", "locked"]] as const) value[key] = data?.database?.[field] ?? null;
  return value as unknown as PageMetaRow;
}
function query(table: string) {
  const filters: ((row: Row) => boolean)[] = [];
  let columns = "", from = 0, to = Infinity, created: Row | null = null;
  const result = async (single: boolean) => {
    if (table === "pages") { h.selects.push({ columns, single }); if (single && h.pauseRead) await h.pauseRead(); }
    const workspace = { id: "ws", owner_id: "person", revision: 1, root_order: h.root, settings: DEFAULT_SETTINGS, synced_blocks: { raw: [b("paragraph", { html: "Must not read raw cache" })] } };
    const source = created ? [created] : table === "workspaces" ? [workspace] : table === "pages" ? h.rows.map((row) => ({ ...row, workspace_id: "ws" })) : [];
    const rows = source.filter((row) => filters.every((filter) => filter(row))).slice(from, to + 1);
    const data = table === "pages" && columns === PAGE_META_COLS ? rows.map((row) => project(row as unknown as PageRow)) : rows;
    return { data: single ? data[0] ?? null : data, error: null };
  };
  const builder: unknown = new Proxy({}, { get: (_, key) => {
    if (key === "then") return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => result(false).then(resolve, reject);
    if (key === "single" || key === "maybeSingle") return () => result(true);
    if (key === "select") return (value: string) => { columns = value; return builder; };
    if (key === "range") return (start: number, end: number) => { from = start; to = end; return builder; };
    if (key === "eq") return (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; };
    if (key === "gte") return (column: string, value: string) => { filters.push((row) => String(row[column]) >= value); return builder; };
    if (key === "insert") return (row: Row) => { created = { ...row, revision: 1, updated_at: new Date(T).toISOString(), deleted_at: null }; if (table === "pages") h.rows.push(created as unknown as PageRow); return builder; };
    return () => builder;
  } });
  return builder;
}
function client() {
  const channel: unknown = new Proxy({}, { get: (_, key) => key === "on" ? (_: string, filter: { table: string; event: string }, callback: (payload: { new: PageRow }) => void) => { h.changes.set(`${filter.table}:${filter.event}`, callback); return channel; } : key === "subscribe" ? (callback: (status: string) => void) => { h.subscribe = callback; return channel; } : () => channel });
  return { from: query, channel: () => channel, removeChannel: async () => {}, getChannels: () => [], rpc: async (name: string, args: Row) => {
    if (name === "read_workspace_synced_blocks") return { data: h.authorized, error: null };
    if (name === "apply_page_ops") { const row = h.rows.find((row) => row.id === args.p_page_id)!; const ops = args.p_ops as PageOp[]; h.sent.push(...ops); const result = applyOps(row.data!, ops, { by: "human", id: "person", at: T }); row.data = result.page; row.revision++; return { data: { revision: row.revision, results: result.results }, error: null }; }
    return { data: { revision: 2, results: [] }, error: null };
  } };
}
const cloud = (id = "p", revision = 2, text = "Cloud body"): PageRow => ({ id, parent_id: null, data: page({ id, revision, updatedAt: T, blocks: [b("paragraph", { id: "text", html: text })] }), revision, updated_at: new Date(T).toISOString(), deleted_at: null });
const person = { id: "person" } as User;
let fake: ReturnType<typeof installFakeIndexedDb>;
beforeEach(() => { stopSync(); stopLocalPersistence(); fake = installFakeIndexedDb(); localStorage.clear(); sessionStorage.clear(); h.rows = [cloud()]; h.root = ["p"]; h.selects = []; h.sent = []; h.initialOps = []; h.authorized = {}; h.changes.clear(); h.subscribe = null; h.pauseRead = null; h.client = client(); window.confirm = vi.fn(() => true); });
afterEach(() => { stopSync(); stopLocalPersistence(); vi.restoreAllMocks(); });
async function setup(pages = [cloud().data!], loaded: string[] = [], disk = true) {
  applyingExternal(() => useStore.setState({ pages: Object.fromEntries(pages.map((p) => [p.id, loaded.includes(p.id) || !disk ? p : shellOf(p)])), rootOrder: pages.map((p) => p.id), syncUserId: "person", syncWorkspaceId: "ws", expanded: {}, syncedBlocks: {}, reminders: [], settings: DEFAULT_SETTINGS }));
  if (disk) { const connection = await openLocalDb(); await claimWorkspace(connection, pages.map((p) => fullWrite(p)), [["rootOrder", useStore.getState().rootOrder], ["syncedBlocks", {}], ["settings", DEFAULT_SETTINGS], ["reminders", []], ["sync", { syncUserId: "person", syncWorkspaceId: "ws" }]], null); startWriter(connection, (await readWorkspace(connection)).epoch); fake.resetStats(); }
}

it("maps metadata to shells, retains database headers/rowOrigin, and distinguishes tombstones from trash", () => {
  const source = cloud(); source.data!.database = db([prop()], []); source.data!.rowOrigin = { databasePageId: "parent", row: row({ attachment: "file" }), index: 0 }; source.deleted_at = new Date(T).toISOString();
  const projected = project(source), mapped = rowFromMeta(projected);
  expect(isShell(mapped.data)).toBe(true); expect(mapped.data?.blocks).toEqual([]); expect(mapped.data?.database?.rows).toEqual([]); expect(mapped.data?.rowOrigin).toEqual(source.data!.rowOrigin);
  expect(rowFromMeta({ ...projected, data_id: null }).data).toBeNull();
  const defaults = rowFromMeta({ ...projected, deleted_at: null, fullWidth: null, icon: null, createdAt: null, rowOrigin: null });
  expect(defaults.data).toMatchObject({ fullWidth: false, icon: null, createdAt: T }); expect(defaults.data).not.toHaveProperty("rowOrigin");
});

it("unchanged startup lists metadata only, preserves page references, and writes no metadata", async () => {
  await setup(); const original = useStore.getState().pages.p; await initSync(person); await flushLocalWrites();
  expect(h.selects).toEqual([{ columns: PAGE_META_COLS, single: false }]); expect(useStore.getState().pages.p).toBe(original); expect(fake.stats.puts.meta ?? 0).toBe(0);
  expect(fake.stats.puts).toEqual({});
  expect(useStore.getState().syncedBlocks).toEqual({});
});

it("metadata pagination applies a thousand incoming shells in one page patch", async () => {
  h.rows = Array.from({ length: 1000 }, (_, i) => cloud(`p${i}`)); h.root = h.rows.map((row) => row.id); await setup([]);
  const apply = vi.spyOn(useStore.getState(), "applyRemotePages"); await initSync(person);
  expect(apply.mock.calls.filter(([patch]) => patch.pages && Object.keys(patch.pages).length)).toHaveLength(1);
  expect(Object.values(useStore.getState().pages)).toHaveLength(1000); expect(Object.values(useStore.getState().pages).every(isShell)).toBe(true);
  expect(h.selects.every((call) => call.columns === PAGE_META_COLS)).toBe(true);
});

it("pending page operations protect the local metadata during startup", async () => {
  await setup([{ ...cloud().data!, title: "Pending local" }]); h.rows[0] = cloud("p", 5); h.rows[0].data!.title = "Remote title";
  h.initialOps = [{ op: "set_page", patch: { title: "Pending local" } }];
  await initSync(person); expect(useStore.getState().pages.p.title).toBe("Pending local"); expect(h.queue!.peek("p")).toEqual(h.initialOps);
});

it.each([false, true])("merge respects tombstone time and loads the body for a newer local copy (%s)", async (newerLocal) => {
  await setup([{ ...cloud().data!, updatedAt: newerLocal ? T + 1 : T - 1 }]);
  h.rows = [{ ...cloud(), data: null, deleted_at: new Date(T).toISOString() }];
  await initSync(person);
  if (newerLocal) { expect(h.queue!.peek("p")[0]).toMatchObject({ op: "replace_page", revision: 2, page: { blocks: [expect.objectContaining({ html: "Cloud body" })] } }); expect(isShell((h.queue!.peek("p")[0] as Extract<PageOp, { op: "replace_page" }>).page)).toBe(false); }
  else expect(useStore.getState().pages.p).toBeUndefined();
});

it("forgetting bodies cancels pending downloads and clears body/search stores without losing metadata", async () => {
  await setup(); persistFull([{ ...cloud().data!, blocks: [b("paragraph", { html: "Must not return" })] }]);
  await forgetLocalBodies(); await flushLocalWrites();
  expect(fake.dump("bodies")).toEqual([]); expect(fake.dump("search")).toEqual([]);
  expect(fake.dump("meta")).toEqual([expect.objectContaining({ id: "p", bodyRev: null })]); expect(await readStoredPage("p")).toBeNull();
});

it("failed body invalidation retains unsaved edits for export and the next successful write", async () => {
  await setup(undefined, ["p"]); useStore.getState().updateBlock("p", "text", { html: "Unsaved protected work" });
  const adapter = await import("@/lib/localDb"); vi.spyOn(adapter, "invalidateBodies").mockRejectedValueOnce(new Error("Cannot invalidate")); fake.failNext("QuotaExceededError");
  await expect(forgetLocalBodies()).rejects.toThrow("Cannot invalidate"); expect(hasPendingLocalWrites()).toBe(true);
  fake.failNext("QuotaExceededError"); expect((await readFullWorkspace()).pages.p.blocks[0].html).toBe("Unsaved protected work");
  await flushLocalWrites(); expect((await readStoredPage("p"))?.page.blocks[0].html).toBe("Unsaved protected work");
});

it("memory mode keeps selecting full bodies", async () => {
  await setup(undefined, [], false); await initSync(person); expect(h.selects[0].columns.split(",")).toContain("data"); expect(isShell(useStore.getState().pages.p)).toBe(false);
});

it("refreshes a loaded stale page in full and leaves unopened pages as metadata", async () => {
  await setup([cloud("p", 1, "Old body").data!], ["p"]); await initSync(person);
  expect(h.selects).toContainEqual(expect.objectContaining({ single: true })); expect(useStore.getState().pages.p.blocks[0].html).toBe("Cloud body");
});

it("on-demand cloud refresh rebases pending edits, writes the full body, and fails safely offline", async () => {
  await setup(); await initSync(person); h.queue!.enqueue("p", [{ op: "set_page", patch: { title: "Pending title" } }]);
  await ensurePageBody("p"); expect(await refreshPageFromCloud("p")).toBe(true); await flushLocalWrites();
  expect(useStore.getState().pages.p.title).toBe("Pending title"); expect((await readStoredPage("p"))?.page.blocks[0].html).toBe("Cloud body");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false); expect(await refreshPageFromCloud("p")).toBe(false);
});

it("initial Realtime catch-up also lists metadata, then refreshes only stale loaded pages", async () => {
  await setup(); await initSync(person); await flushLocalWrites(); fake.resetStats();
  const before = useStore.getState().pages.p; h.selects = []; h.subscribe!("SUBSCRIBED");
  await vi.waitFor(() => expect(h.selects.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.selects.filter((call) => !call.single).every((call) => call.columns === PAGE_META_COLS)).toBe(true);
  await flushLocalWrites(); expect(useStore.getState().pages.p).toBe(before); expect(fake.stats.puts).toEqual({});
  h.selects = []; h.changes.get("pages:UPDATE")!({ new: { ...cloud("p", 4), data: null } });
  expect(h.selects).toEqual([]); expect(useStore.getState().pages.p.revision).toBe(4); expect(isShell(useStore.getState().pages.p)).toBe(true);
});

it("server choice forgets old bodies even at equal revisions and preserves metadata counts", async () => {
  await setup([cloud("p", 2, "Local discarded").data!], ["p"]);
  h.rows[0].data!.title = "Server title";
  useStore.setState({ syncUserId: null, syncWorkspaceId: null }); useStore.getState().updatePage("p", { title: "Meaningful local" });
  const syncing = initSync(person); await vi.waitFor(() => expect(useSyncConflict.getState().prompt).not.toBeNull());
  expect(useSyncConflict.getState().prompt).toMatchObject({ serverPageCount: 1, localPageCount: 1 }); useSyncConflict.getState().prompt!.resolve("server"); await syncing;
  expect(isShell(useStore.getState().pages.p)).toBe(true); expect(await readStoredPage("p")).toBeNull();
  await flushLocalWrites(); expect(fake.dump("meta")).toEqual([expect.objectContaining({ title: "Server title", bodyRev: null })]);
  expect(await ensurePageBody("p")).toBe("ready"); expect(useStore.getState().pages.p.blocks[0].html).toBe("Cloud body");
});

it("force pull discards unsynced equal-revision cache and reopening fetches the cloud body", async () => {
  await setup(undefined, ["p"]); await initSync(person); useStore.getState().updateBlock("p", "text", { html: "Discard this edit" });
  await forceFullPull(); expect(isShell(useStore.getState().pages.p)).toBe(true); expect(await readStoredPage("p")).toBeNull();
  await ensurePageBody("p"); expect(useStore.getState().pages.p.blocks[0].html).toBe("Cloud body");
});

it("a cloud body response from a stopped generation cannot enter another session", async () => {
  await setup(); await initSync(person); let finish!: () => void; h.pauseRead = () => new Promise((resolve) => { finish = resolve; });
  const reading = refreshPageFromCloud("p"); await vi.waitFor(() => expect(finish).toBeTypeOf("function")); stopSync();
  applyingExternal(() => useStore.setState({ pages: { p: shellOf(page({ id: "p", title: "Other account" })) }, syncUserId: "other", syncWorkspaceId: "other" }));
  finish(); expect(await reading).toBe(false); expect(useStore.getState().pages.p.title).toBe("Other account"); expect(isShell(useStore.getState().pages.p)).toBe(true);
});
