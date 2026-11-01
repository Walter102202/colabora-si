// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, db, page, prop, row } from "./fixtures";
import { DEFAULT_SETTINGS } from "@/lib/factories";

let fake: ReturnType<typeof installFakeIndexedDb>;
beforeEach(() => { vi.resetModules(); localStorage.clear(); fake = installFakeIndexedDb(); });
afterEach(async () => { const storage = await import("@/lib/localPersistence"); storage.stopLocalPersistence(); });
async function modules() {
  return { storage: await import("@/lib/localPersistence"), store: (await import("@/lib/store")).useStore };
}
function legacy() {
  const pages = Object.fromEntries(Array.from({ length: 50 }, (_, i) => {
    const p = page({ id: `p${i}`, blocks: [b("paragraph", { html: `body ${i}` })] });
    return [p.id, p];
  }));
  pages.p0.database = db([prop()], [row({ title: "Row" }, "p1")]);
  pages.p1.rowOrigin = { databasePageId: "p0", index: 0, row: pages.p0.database.rows[0] };
  return { pages, rootOrder: ["p0"], expanded: { p0: true }, syncedBlocks: {}, reminders: [{ id: "r", pageId: "p0", text: "Remember", date: "2026-11-05", createdAt: 1 }], settings: DEFAULT_SETTINGS, syncUserId: "person", syncWorkspaceId: "workspace" };
}
function save(value = legacy()) { localStorage.setItem("colabora-workspace", JSON.stringify({ state: value, version: 1 })); return value; }

it("migrates every field atomically, retains recovery and old storage for one boot, then removes only the old key", async () => {
  const initial = save(); localStorage.setItem("colabora-recovery:person:p0", "rescue");
  let { storage, store } = await modules(); await storage.hydrateWorkspace();
  for (const key of Object.keys(initial) as (keyof typeof initial)[]) expect(store.getState()[key]).toEqual(initial[key]);
  expect(fake.dump("bodies")).toHaveLength(50); expect(localStorage.getItem("colabora-workspace")).not.toBeNull();
  storage.stopLocalPersistence(); vi.resetModules(); ({ storage, store } = await modules()); await storage.hydrateWorkspace();
  expect(store.getState().pages).toEqual(initial.pages);
  expect(localStorage.getItem("colabora-workspace")).toBeNull();
  expect(localStorage.getItem("colabora-recovery:person:p0")).toBe("rescue");
});

it("falls back to the intact legacy copy after an atomic failure and retries next boot", async () => {
  const initial = save(); fake.failNext("QuotaExceededError");
  let { storage, store } = await modules(); await storage.hydrateWorkspace();
  expect(storage.useLocalHealth.getState().health).toBe("unavailable"); expect(storage.diskAvailable()).toBe(false);
  expect(store.getState().pages).toEqual(initial.pages);
  for (const name of ["meta", "bodies", "search", "kv"]) expect(fake.dump(name)).toEqual([]);
  expect(localStorage.getItem("colabora-workspace")).not.toBeNull();
  storage.stopLocalPersistence(); vi.resetModules(); ({ storage } = await modules()); await storage.hydrateWorkspace();
  expect(fake.dump("bodies")).toHaveLength(50); expect(storage.useLocalHealth.getState().health).toBe("ok");
});

it("persists the initial page IDs before any edit so direct links survive a reload", async () => {
  let { storage, store } = await modules(); const seed = store.getState();
  const history = await import("@/lib/history"); history.initHistory();
  await storage.hydrateWorkspace();
  expect(store.getState().pages).toBe(seed.pages); expect(history.canUndo()).toBe(false);
  const adapter = await import("@/lib/localDb"), disk = await adapter.openLocalDb();
  expect((await adapter.readWorkspace(disk)).kv.rootOrder).toEqual(seed.rootOrder); disk.close();
  fake.resetStats(); await storage.hydrateWorkspace(); expect(fake.stats.puts).toEqual({});
  storage.stopLocalPersistence(); vi.resetModules(); ({ storage, store } = await modules()); await storage.hydrateWorkspace();
  expect(Object.keys(store.getState().pages)).toEqual(Object.keys(seed.pages).sort());
  expect(store.getState().rootOrder).toEqual(seed.rootOrder);
});

it("A-2-20 uses schema 1 and excludes foreign pages and directory caches", async () => {
  const { storage, store } = await modules(); const foreign = await import("@/lib/foreignPages");
  foreign.foreignPageIds.add("foreign");
  store.setState({ pages: { local: page({ id: "local" }), foreign: page({ id: "foreign" }) }, members: ["private"], agents: ["private"] } as never);
  await storage.hydrateWorkspace();
  expect(fake.dump("meta")).toEqual([expect.objectContaining({ id: "local" })]);
  const adapter = await import("@/lib/localDb"), disk = await adapter.openLocalDb(), saved = await adapter.readWorkspace(disk); disk.close();
  expect(saved.kv.schema).toBe(1); expect(saved.kv).not.toHaveProperty("members"); expect(saved.kv).not.toHaveProperty("agents");
});

it("treats corrupt JSON as absent and keeps the generated seed", async () => {
  localStorage.setItem("colabora-workspace", "{"); const { storage, store } = await modules(); const seed = store.getState().pages;
  await storage.hydrateWorkspace(); expect(storage.useLocalHealth.getState().health).toBe("ok"); expect(store.getState().pages).toBe(seed);
});

it("two fresh tabs converge on one seed", async () => {
  const first = await modules(); vi.resetModules(); const second = await modules();
  await Promise.all([first.storage.hydrateWorkspace(), second.storage.hydrateWorkspace()]);
  expect(second.store.getState().pages).toEqual(first.store.getState().pages);
  first.storage.stopLocalPersistence();
});

it("two migrating tabs commit a single complete copy", async () => {
  const initial = save(), first = await modules(); vi.resetModules(); const second = await modules();
  await Promise.all([first.storage.hydrateWorkspace(), second.storage.hydrateWorkspace()]);
  expect(fake.dump("bodies")).toHaveLength(50);
  expect(first.store.getState().pages).toEqual(initial.pages); expect(second.store.getState().pages).toEqual(initial.pages);
  first.storage.stopLocalPersistence();
});

it("rejects a migration count mismatch and permits a clean retry from retained legacy data", async () => {
  const initial = save(), adapter = await import("@/lib/localDb");
  const count = vi.spyOn(adapter, "countRecords").mockResolvedValueOnce({ meta: 49, bodies: 50 });
  let { storage, store } = await modules(); await storage.hydrateWorkspace(); count.mockRestore();
  expect(storage.useLocalHealth.getState().health).toBe("unavailable");
  expect(store.getState().pages).toEqual(initial.pages); expect(localStorage.getItem("colabora-workspace")).not.toBeNull();
  for (const name of ["meta", "bodies", "search", "kv"]) expect(fake.dump(name)).toEqual([]);
  storage.stopLocalPersistence(); vi.resetModules(); ({ storage } = await modules()); await storage.hydrateWorkspace();
  expect(fake.dump("bodies")).toHaveLength(50);
});

it("absorbs only newer same-account legacy pages and cannot resurrect an old deleted page", async () => {
  const initial = save(); let { storage, store } = await modules(); await storage.hydrateWorkspace();
  store.setState(({ pages }) => ({ pages: Object.fromEntries(Object.entries(pages).filter(([id]) => id !== "p2")) })); await storage.flushLocalWrites();
  const incoming = structuredClone(initial); incoming.pages.p0.title = "New legacy"; incoming.pages.p0.updatedAt = Date.now() + 100;
  incoming.pages.new = page({ id: "new", createdAt: Date.now() + 100 }); save(incoming);
  storage.stopLocalPersistence(); vi.resetModules(); ({ storage, store } = await modules()); await storage.hydrateWorkspace();
  expect(store.getState().pages.p0.title).toBe("New legacy"); expect(store.getState().pages.p2).toBeUndefined(); expect(store.getState().pages.new).toBeDefined();
  expect(store.getState().rootOrder).toContain("new");
  const other = legacy(); other.syncUserId = "another"; other.pages.p0.title = "Other account"; other.pages.p0.updatedAt = Date.now() + 1000; save(other);
  storage.stopLocalPersistence(); vi.resetModules(); ({ storage, store } = await modules()); await storage.hydrateWorkspace();
  expect(store.getState().pages.p0.title).toBe("New legacy");
});

it("does not touch pending operations during migration", async () => {
  save(); const { MemoryQueue } = await import("@/lib/opsQueue"), queue = new MemoryQueue();
  queue.enqueue("p0", [{ op: "set_page", patch: { title: "Pending" } }]); const before = queue.peek("p0");
  const { storage } = await modules(); await storage.hydrateWorkspace(); expect(queue.peek("p0")).toEqual(before);
  const { PageSyncEngine } = await import("@/lib/sync");
  const send = vi.fn<(id: string, ops: unknown[]) => Promise<{ revision: number; results: [] }>>(async () => ({ revision: 1, results: [] }));
  const engine = new PageSyncEngine(queue, "client", { by: "human", id: "person", at: 1 }, {
    getPage: () => undefined, apply: () => {}, read: async () => null, send, conflict: () => {}, pageConflict: () => {},
  });
  await engine.flushPage("p0"); expect(send.mock.calls[0]?.[1]).toEqual(before); expect(queue.peek("p0")).toEqual([]);
});
