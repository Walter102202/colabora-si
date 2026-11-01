// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import * as sync from "@/lib/sync";
import * as persistence from "@/lib/localPersistence";
import * as history from "@/lib/history";
import { useStore } from "@/lib/store";
import { applyingExternal } from "@/lib/externalApply";
import { isShell, shellOf, splitPage } from "@/lib/pageShell";
import { claimWorkspace, openLocalDb, readWorkspace } from "@/lib/localDb";
import type { PageRow } from "@/lib/syncMerge";
import type { MemoryQueue } from "@/lib/opsQueue";
import { DEFAULT_SETTINGS } from "@/lib/factories";
import { installFakeChannels, installFakeIndexedDb } from "./fakeIndexedDb";
import { b, page, T } from "./fixtures";

type Reply = { data: unknown; error: unknown };
const h = vi.hoisted(() => ({ rows: [] as PageRow[], batches: [] as string[][], queue: null as MemoryQueue | null, pause: null as ((reply: Reply) => Promise<Reply>) | null, pending: false }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => client(), isSupabaseConfigured: () => true }));
vi.mock("@/lib/fileStore", async (original) => ({ ...await original<typeof import("@/lib/fileStore")>(), onFileSyncStart: () => {}, onFileSyncStop: () => {}, hasPendingUploads: () => false }));
vi.mock("@/lib/opsQueue", async (original) => {
  const actual = await original<typeof import("@/lib/opsQueue")>();
  class Queue extends actual.MemoryQueue {
    ready = Promise.resolve();
    constructor() { super(); h.queue = this; if (h.pending) { this.enqueue("p2", [{ op: "set_page", patch: { title: "pending" } }]); this.markDeleted("p1"); } }
    async close() {}
  }
  return { ...actual, IndexedDbQueue: Queue };
});
function query(table: string) {
  let columns = "", ids: string[] | null = null, single = false, mutating = false, from = 0, to = Infinity;
  const reply = async (): Promise<Reply> => {
    if (mutating) return { data: null, error: new Error("Keep queued operations pending") };
    let rows: unknown[] = table === "pages" ? h.rows : table === "workspaces" ? [{ id: "ws", owner_id: "owner", root_order: h.rows.map((r) => r.id), settings: DEFAULT_SETTINGS, revision: 1, updated_at: new Date(T).toISOString() }] : [];
    if (table === "pages" && ids) { h.batches.push(ids); rows = h.rows.filter((row) => ids!.includes(row.id)); }
    if (table === "pages" && columns === sync.PAGE_META_COLS) rows = rows.map((row) => Object.fromEntries(columns.split(",").map((column) => {
      const [name, source = name] = column.split(":");
      const value = source.split(/->>?/).reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null, row);
      return [name, value ?? null];
    })));
    rows = rows.slice(from, to + 1);
    const result = { data: single ? rows[0] ?? null : rows, error: null };
    return ids && h.pause ? h.pause(result) : result;
  };
  const builder: unknown = new Proxy({}, { get: (_, key) => {
    if (key === "then") return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => reply().then(resolve, reject);
    if (key === "single" || key === "maybeSingle") return () => { single = true; return reply(); };
    if (key === "select") return (value: string) => { columns = value; return builder; };
    if (key === "in") return (_key: string, value: string[]) => { ids = value; return builder; };
    if (key === "range") return (start: number, end: number) => { from = start; to = end; return builder; };
    if (key === "update" || key === "insert" || key === "delete") return () => { mutating = true; return builder; };
    return () => builder;
  } }); return builder;
}
function client() {
  const channel = { on: () => channel, subscribe: () => channel };
  return { from: query, channel: () => channel, removeChannel: async () => {}, getChannels: () => [], rpc: async (name: string) => name === "read_workspace_synced_blocks" ? { data: {}, error: null } : name === "apply_page_ops" ? { data: null, error: new Error("Pending") } : { data: { revision: 1, results: [] }, error: null } };
}
let fake: ReturnType<typeof installFakeIndexedDb>;
beforeEach(() => { sync.stopSync(); persistence.stopLocalPersistence(); vi.useFakeTimers(); fake = installFakeIndexedDb(); installFakeChannels(); localStorage.clear(); sessionStorage.clear(); h.rows = []; h.batches = []; h.pause = null; h.pending = false; h.queue = null; });
afterEach(() => { sync.stopSync(); persistence.stopLocalPersistence(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const settle = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
async function setup(count = 3) {
  h.rows = Array.from({ length: count }, (_, i) => { const p = page({ id: `p${i}`, revision: 2, updatedAt: T + i, blocks: [b("paragraph", { html: `body ${i}` })] }); return { id: p.id, data: p, revision: 2, updated_at: new Date(p.updatedAt).toISOString(), deleted_at: null }; });
  applyingExternal(() => useStore.setState({ pages: Object.fromEntries(h.rows.map((row) => [row.id, shellOf(row.data!)])), rootOrder: h.rows.map((row) => row.id), syncedBlocks: {}, reminders: [], settings: DEFAULT_SETTINGS, syncUserId: "owner", syncWorkspaceId: "ws" }));
  const connection = await openLocalDb();
  await claimWorkspace(connection, h.rows.map((row) => ({ kind: "meta", id: row.id, meta: splitPage(row.data!).meta })), [], null);
  persistence.startWriter(connection, (await readWorkspace(connection)).epoch); persistence.useLocalHealth.setState({ health: "ok" }); fake.resetStats();
  await sync.initSync({ id: "owner" } as User);
}

it("downloads newest-first in batches of fifty, keeps shells, and finishes only after the disk is complete", async () => {
  const rebase = vi.spyOn(history, "rebaseHistory"); await setup(121); await settle(); rebase.mockClear();
  const finishing = sync.finishBodyDownload(); await vi.advanceTimersByTimeAsync(1000);
  await expect(finishing).resolves.toBe(true);
  expect(h.batches.map((batch) => batch.length)).toEqual([50, 50, 21]);
  expect(h.batches.flat()).toEqual(Array.from({ length: 121 }, (_, i) => `p${120 - i}`));
  expect(fake.dump("bodies")).toHaveLength(121); expect(await persistence.hasMissingBodies()).toBe(false);
  expect(Object.values(useStore.getState().pages).every(isShell)).toBe(true); expect(rebase).not.toHaveBeenCalled();
});

it("skips pages with pending operations or deletion markers", async () => {
  h.pending = true; await setup(); await settle();
  const finishing = sync.finishBodyDownload(); await vi.advanceTimersByTimeAsync(500);
  await expect(finishing).resolves.toBe(false);
  expect(fake.dump("bodies")).toEqual([expect.objectContaining({ id: "p0" })]);
  expect(h.queue!.peek("p2")).not.toEqual([]); expect(h.queue!.isDeleted("p1")).toBe(true);
});

it.each(["full", "failing"] as const)("stops before applying an in-flight response when storage becomes %s", async (health) => {
  let release!: () => void; h.pause = (reply) => new Promise((resolve) => { release = () => resolve(reply); });
  await setup(); await settle(); expect(release).toBeTypeOf("function");
  persistence.useLocalHealth.setState({ health }); release(); await settle();
  expect(fake.dump("bodies")).toEqual([]); await expect(sync.finishBodyDownload()).resolves.toBe(false);
  h.pause = null; persistence.useLocalHealth.setState({ health: "ok" }); await settle();
  await expect(sync.finishBodyDownload()).resolves.toBe(true); expect(fake.dump("bodies")).toHaveLength(3);
});

it("stops offline and resumes after the online pull", async () => {
  await setup(51); await settle();
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(300); expect(h.batches).toHaveLength(1);
  online.mockReturnValue(true); window.dispatchEvent(new Event("online")); await settle();
  const finishing = sync.finishBodyDownload(); await vi.advanceTimersByTimeAsync(500); await expect(finishing).resolves.toBe(true);
  expect(fake.dump("bodies")).toHaveLength(51);
});

it("ignores an old session's in-flight response after stopSync", async () => {
  let release!: () => void; h.pause = (reply) => new Promise((resolve) => { release = () => resolve(reply); });
  await setup(); await settle(); expect(release).toBeTypeOf("function");
  sync.stopSync(); release(); await settle(); await persistence.flushLocalWrites();
  expect(fake.dump("bodies")).toEqual([]);
});

it("uses ifAvailable for background work and waits for the lock on an explicit finish", async () => {
  const request = vi.fn(async (name: string, options: unknown, callback?: (lock: object | null) => unknown) => {
    if (typeof options === "function") return options({});
    if (name === "colabora-body-fill" && (options as { ifAvailable?: boolean }).ifAvailable) return callback!(null);
    return callback!({});
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  await setup(); await settle(); expect(h.batches).toEqual([]);
  const finishing = sync.finishBodyDownload(); await vi.advanceTimersByTimeAsync(500); await expect(finishing).resolves.toBe(true);
  expect(request.mock.calls.some(([name, options]) => name === "colabora-body-fill" && (options as { ifAvailable?: boolean })?.ifAvailable)).toBe(true);
  expect(fake.dump("bodies")).toHaveLength(3);
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
});

it("does not replace newer memory or disk with a response fetched before a newer remote update", async () => {
  let release!: () => void; h.pause = (reply) => new Promise((resolve) => { release = () => resolve(reply); });
  await setup(1); await settle();
  const newer = { ...h.rows[0].data!, revision: 3, blocks: [b("paragraph", { html: "newer" })] };
  applyingExternal(() => useStore.getState().applyRemotePages({ pages: { p0: newer } })); await persistence.flushLocalWrites();
  release(); await settle(); await persistence.flushLocalWrites();
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "newer" }] });
  expect(useStore.getState().pages.p0.revision).toBe(3);
});
