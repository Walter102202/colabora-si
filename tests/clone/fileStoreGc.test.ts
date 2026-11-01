// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeChannels, installFakeIndexedDb } from "./fakeIndexedDb";
import { b, page, row } from "./fixtures";
import type { Page } from "@/lib/types";

const h = vi.hoisted(() => ({ client: null as unknown, removed: vi.fn(), uploaded: vi.fn(), rows: [] as { id: string }[] }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => h.client, isSupabaseConfigured: () => !!h.client }));
let fake: ReturnType<typeof installFakeIndexedDb>;
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); localStorage.clear(); fake = installFakeIndexedDb(); installFakeChannels(); h.client = null; h.rows = []; h.removed.mockReset().mockResolvedValue({ error: null }); h.uploaded.mockReset().mockResolvedValue({ error: null }); });
afterEach(async () => { (await import("@/lib/fileStore")).onFileSyncStop(); (await import("@/lib/localPersistence")).stopLocalPersistence(); vi.restoreAllMocks(); vi.useRealTimers(); });
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const attached = (patch: Partial<Page> = {}) => page({ id: "p", revision: 1, blocks: [b("file", { id: "file-block", fileId: "kept" })], ...patch });
function cloud(download: () => Promise<{ data: Blob | null }> = async () => ({ data: null })) {
  const query: unknown = new Proxy({}, { get: (_, key) => key === "then" ? (resolve: (value: unknown) => void) => resolve({ data: h.rows, error: null }) : () => query });
  h.client = { from: () => query, storage: { from: () => ({ remove: h.removed, upload: h.uploaded, download }) } };
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
}
async function setup(content = attached(), missing = false) {
  const storage = await import("@/lib/localPersistence"), adapter = await import("@/lib/localDb"), shells = await import("@/lib/pageShell");
  const files = await import("@/lib/fileStore"), store = (await import("@/lib/store")).useStore;
  const connection = await adapter.openLocalDb(), write = storage.fullWrite(content);
  await adapter.claimWorkspace(connection, missing ? [{ kind: "meta", id: content.id, meta: write.meta }] : [write], [], null);
  store.setState({ pages: { [content.id]: shells.shellOf(content) }, rootOrder: [content.id], syncedBlocks: {}, syncUserId: null, syncWorkspaceId: null });
  storage.startWriter(connection, (await adapter.readWorkspace(connection)).epoch);
  await files.putFile("kept", new Blob(["saved"]));
  return { storage, adapter, files, store, shells, connection };
}
async function uploadedMarker(id: string, workspace: string) {
  const request = indexedDB.open("colabora-files", 2);
  const connection = await new Promise<IDBDatabase>((resolve) => { request.onsuccess = () => resolve(request.result); });
  await new Promise<void>((resolve) => { const tx = connection.transaction("uploaded", "readwrite"); tx.objectStore("uploaded").put(workspace, id); tx.oncomplete = () => resolve(); });
  connection.close();
}

it("preserves disk-only attachment references in manual and scheduled cleanup", async () => {
  const { files } = await setup(); cloud(); h.rows = [{ id: "kept" }]; files.onFileSyncStart("ws"); await settle();
  expect(await files.listReferencedFileIds()).toContain("kept");
  expect(await files.cleanupUnusedFiles()).toMatchObject({ deleted: 0 });
  files.scheduleBlobGc(["kept"], 10); await vi.advanceTimersByTimeAsync(10); await settle();
  expect(fake.dump("files")).toHaveLength(1); expect(h.removed).not.toHaveBeenCalled();
});

it("preserves an attachment present only in a trashed shell's rowOrigin", async () => {
  const content = attached({ blocks: [], isDeleted: true, rowOrigin: { databasePageId: "db", index: 0, row: row({ files: [{ fileId: "kept" }] }, "p") } });
  const { files } = await setup(content);
  expect(await files.listReferencedFileIds()).toContain("kept");
  expect(await files.cleanupUnusedFiles()).toMatchObject({ deleted: 0 }); expect(fake.dump("files")).toHaveLength(1);
});

it.each(["missing", "stale"])("refuses to delete any file when a body is %s", async (kind) => {
  const { files, store } = await setup(attached(), kind === "missing"); cloud(); h.rows = [{ id: "unseen-cloud-file" }]; files.onFileSyncStart("ws");
  if (kind === "stale") store.setState(({ pages }) => ({ pages: { p: { ...pages.p, revision: 2 } } }));
  expect(await files.listReferencedFileIds()).toBeNull();
  await expect(files.cleanupUnusedFiles()).rejects.toThrow("pages_not_on_device");
  files.scheduleBlobGc(["kept"], 10); await vi.advanceTimersByTimeAsync(10); await settle();
  expect(fake.dump("files")).toHaveLength(1); expect(h.removed).not.toHaveBeenCalled();
});

it.each(["permanentlyDelete", "emptyTrash"] as const)("%s captures unloaded attachments before deleting the page body", async (action) => {
  const { files, storage } = await setup(attached({ isDeleted: true }));
  const bodies = await import("@/lib/pageBodies");
  if (action === "permanentlyDelete") await bodies.permanentlyDeleteLoaded("p"); else await bodies.emptyTrashLoaded();
  await storage.flushLocalWrites(); await settle();
  expect(fake.dump("bodies")).toEqual([]);
  await vi.advanceTimersByTimeAsync(30_000); await settle();
  expect(fake.dump("files")).toEqual([]); expect(await files.listReferencedFileIds()).toEqual([]);
});

it.each(["permanentlyDelete", "emptyTrash"] as const)("undo after %s preserves the original body and prevents scheduled attachment deletion", async (action) => {
  const original = attached({ isDeleted: true }), { files, store, storage } = await setup(original);
  const history = await import("@/lib/history"), bodies = await import("@/lib/pageBodies"); history.initHistory(); history.clearHistory();
  if (action === "permanentlyDelete") await bodies.permanentlyDeleteLoaded(original.id); else await bodies.emptyTrashLoaded();
  await storage.flushLocalWrites(); history.undo(); await storage.flushLocalWrites();
  await vi.advanceTimersByTimeAsync(30_000); await settle();
  expect(store.getState().pages.p).toEqual(original); expect((await storage.readStoredPage("p"))?.page).toEqual(original);
  expect(fake.dump("files")).toHaveLength(1); expect(await files.listReferencedFileIds()).toContain("kept");
});

it("finds pending uploads by file keys without reading page bodies", async () => {
  const { files } = await setup(); await files.putFile("already", new Blob(["sent"]));
  await uploadedMarker("already", "ws");
  fake.resetStats(); cloud(); files.onFileSyncStart("ws"); await settle();
  expect(files.useUploadState.getState().uploading).toEqual({ kept: true });
  expect(fake.stats.reads.bodies ?? 0).toBe(0);
});

it("uses complete memory pages when there is no disk writer", async () => {
  const files = await import("@/lib/fileStore"), store = (await import("@/lib/store")).useStore;
  store.setState({ pages: { p: attached() }, syncedBlocks: { shared: [b("image", { fileId: "synced-file" })] } });
  expect(await files.listReferencedFileIds()).toEqual(expect.arrayContaining(["kept", "synced-file"]));
});

it("keeps a persistent barrier after failed file clearing and retries before exposing old blobs", async () => {
  let { files } = await setup();
  await uploadedMarker("kept", "old-workspace");
  fake.failNext("UnknownError"); await expect(files.clearLocalFiles()).rejects.toBeDefined();
  expect(localStorage.getItem("colabora-files-clear-pending")).not.toBeNull();
  expect(fake.dump("files")).toHaveLength(1); expect(fake.dump("uploaded")).toEqual(["old-workspace"]);
  fake.failNext("UnknownError"); await expect(files.putFile("blocked", new Blob(["blocked write"]))).rejects.toBeDefined();
  expect(fake.dump("files")).toHaveLength(1);
  vi.resetModules(); files = await import("@/lib/fileStore");
  fake.failNext("UnknownError"); await expect(files.getFile("kept")).rejects.toBeDefined();
  expect(localStorage.getItem("colabora-files-clear-pending")).not.toBeNull();
  cloud(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  files.onFileSyncStart("new-workspace"); await settle();
  expect(h.uploaded).not.toHaveBeenCalled(); expect(fake.dump("files")).toEqual([]);
  expect(fake.dump("uploaded")).toEqual([]); expect(localStorage.getItem("colabora-files-clear-pending")).toBeNull();
  await expect(files.getFile("kept")).resolves.toBeUndefined();
  await files.putFile("new-import", new Blob(["new account import"])); await settle();
  expect(h.uploaded).toHaveBeenCalledWith("new-workspace/new-import", expect.anything(), expect.anything());
});

it("does not upload already uploaded blobs into a different workspace", async () => {
  const { files } = await setup(); await uploadedMarker("kept", "old-workspace");
  cloud(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  files.onFileSyncStart("new-workspace"); await settle();
  expect(h.uploaded).not.toHaveBeenCalled(); expect(files.useUploadState.getState().uploading).toEqual({});
});

it("does not let an old in-flight download recreate files after clearing", async () => {
  const { files } = await setup();
  let finish!: (value: { data: Blob }) => void;
  cloud(() => new Promise((resolve) => { finish = resolve; })); files.onFileSyncStart("old-workspace");
  const downloading = files.getFile("remote"); await settle();
  expect(finish).toBeTypeOf("function"); await files.clearLocalFiles();
  finish({ data: new Blob(["old account data"]) });
  await expect(downloading).resolves.toBeUndefined(); expect(fake.dump("files")).toEqual([]);
});

it("keeps the barrier and reports failure when its persistent marker cannot be removed", async () => {
  const { files } = await setup();
  vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new Error("blocked storage"); });
  const outcome = files.clearLocalFiles().then(() => "cleared", () => "blocked");
  await settle();
  const observed = await Promise.race([outcome, Promise.resolve("still pending")]);
  // Bound the old retry loop so a regression cannot leave a runner spinning.
  fake.failNext("UnknownError"); await outcome;
  expect(observed).toBe("blocked");
  expect(localStorage.getItem("colabora-files-clear-pending")).not.toBeNull();
});
