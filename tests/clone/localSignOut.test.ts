// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, page } from "./fixtures";

let fake: ReturnType<typeof installFakeIndexedDb>;
beforeEach(() => { vi.resetModules(); localStorage.clear(); fake = installFakeIndexedDb(); });
afterEach(async () => { (await import("@/lib/localPersistence")).stopLocalPersistence(); vi.restoreAllMocks(); });
async function setup() {
  const storage = await import("@/lib/localPersistence"), { useStore: store } = await import("@/lib/store");
  const privatePage = page({ id: "private-a", blocks: [b("paragraph", { id: "text", html: "Account A secret" })] });
  store.setState({ pages: { [privatePage.id]: privatePage }, rootOrder: [privatePage.id], syncUserId: "account-a", syncWorkspaceId: "ws-a" });
  await storage.hydrateWorkspace();
  return { storage, store, privatePage };
}
function expectNoAccount() {
  for (const name of ["meta", "bodies", "search", "kv"]) expect(JSON.stringify(fake.dump(name))).not.toMatch(/private-a|Account A secret|account-a|ws-a/);
}

it("discards disk account data and pending edits, preserving rescue copies and shared operations", async () => {
  const { storage, store, privatePage } = await setup();
  const recovery = await import("@/lib/syncConflicts"), queues = await import("@/lib/opsQueue");
  recovery.savePageRecovery("account-a", privatePage);
  const shared = new queues.IndexedDbQueue("account-a:shared:page", "tab"), own = new queues.IndexedDbQueue("account-a:ws-a", "tab");
  shared.enqueue("shared-page", [{ op: "set_page", patch: { title: "Unsynced shared work" } }]);
  own.enqueue("private-a", [{ op: "set_page", patch: { title: "Private pending work" } }]);
  await Promise.all([shared.settled(), own.settled()]);
  const clear = vi.spyOn(queues, "clearStoredOps");
  localStorage.setItem("colabora-workspace", JSON.stringify({ state: store.getState() }));
  store.getState().updateBlock("private-a", "text", { html: "Pending private edit" });
  await (await import("@/lib/sync")).discardLocalCopy(); await storage.flushLocalWrites();
  expectNoAccount();
  expect(localStorage.getItem("colabora-workspace")).toBeNull();
  expect(localStorage.getItem("colabora-clear-pending")).toBeNull();
  expect(clear).toHaveBeenCalledWith(true);
  expect(fake.dump("ops")).toEqual([expect.objectContaining({ entries: [expect.objectContaining({ op: { op: "set_page", patch: { title: "Unsynced shared work" } } })] })]);
  expect(localStorage.getItem("colabora-recovery:account-a:private-a")).toContain("Account A secret");
  recovery.loadPageRecoveries("account-b", "private-a");
  expect(recovery.pageRecoveryCopies("account-b", "private-a")).toEqual([]);
  expect(store.getState().syncUserId).toBeNull();
  const adapter = await import("@/lib/localDb"), db = await adapter.openLocalDb();
  expect((await adapter.readWorkspace(db)).kv.sync).toEqual({ syncUserId: null, syncWorkspaceId: null }); db.close();
  await Promise.all([shared.close(), own.close()]);
});

it("an already-issued write completes before the wipe and cannot return after it", async () => {
  const { storage, store } = await setup();
  store.getState().updateBlock("private-a", "text", { html: "Account A secret in flight" });
  const writing = storage.flushLocalWrites();
  store.getState().clearLocalWorkspace();
  await storage.clearLocalPages(); await writing.catch(() => {}); await storage.flushLocalWrites();
  expectNoAccount(); expect(storage.hasPendingLocalWrites()).toBe(false);
});

it("finishes an interrupted clear before reading disk or legacy account data", async () => {
  let { storage, store } = await setup();
  localStorage.setItem("colabora-workspace", JSON.stringify({ state: store.getState() }));
  localStorage.setItem("colabora-clear-pending", "1");
  storage.stopLocalPersistence(); vi.resetModules();
  storage = await import("@/lib/localPersistence"); store = (await import("@/lib/store")).useStore;
  await storage.hydrateWorkspace();
  expectNoAccount(); expect(store.getState().syncUserId).toBeNull();
  expect(localStorage.getItem("colabora-workspace")).toBeNull();
  expect(localStorage.getItem("colabora-clear-pending")).toBeNull();
  expect(storage.useLocalHealth.getState().health).toBe("ok");
});

it("falls back to database deletion when a wipe fails", async () => {
  const { storage, store } = await setup(), adapter = await import("@/lib/localDb");
  vi.spyOn(adapter, "wipeLocalDb").mockRejectedValueOnce(new Error("disk failed"));
  const deletion = vi.spyOn(indexedDB, "deleteDatabase");
  store.getState().clearLocalWorkspace(); await storage.clearLocalPages();
  expect(deletion).toHaveBeenCalledWith("colabora-local"); expectNoAccount();
  expect(localStorage.getItem("colabora-clear-pending")).toBeNull();
});

it("retains the clear marker when both deletion paths fail and retries next boot", async () => {
  let { storage, store } = await setup(); const adapter = await import("@/lib/localDb");
  vi.spyOn(adapter, "wipeLocalDb").mockRejectedValueOnce(new Error("disk failed")); fake.failNext("UnknownError");
  store.getState().clearLocalWorkspace(); await storage.clearLocalPages();
  expect(localStorage.getItem("colabora-clear-pending")).not.toBeNull();
  expect(storage.diskAvailable()).toBe(false);
  storage.stopLocalPersistence(); vi.resetModules();
  storage = await import("@/lib/localPersistence"); store = (await import("@/lib/store")).useStore;
  await storage.hydrateWorkspace(); expectNoAccount();
  expect(store.getState().syncUserId).toBeNull(); expect(localStorage.getItem("colabora-clear-pending")).toBeNull();
});

it("deletes an earlier disk copy even when this session has no active disk writer", async () => {
  const { storage, store } = await setup(); storage.stopLocalPersistence();
  store.getState().clearLocalWorkspace(); await storage.clearLocalPages();
  expectNoAccount(); expect(localStorage.getItem("colabora-clear-pending")).toBeNull();
});
