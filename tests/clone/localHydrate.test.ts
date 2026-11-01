// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, page } from "./fixtures";
import type { Page } from "@/lib/types";

let fake: ReturnType<typeof installFakeIndexedDb>;
beforeEach(() => { vi.resetModules(); localStorage.clear(); fake = installFakeIndexedDb(); });
afterEach(async () => { (await import("@/lib/localPersistence")).stopLocalPersistence(); });
async function modules() {
  return { storage: await import("@/lib/localPersistence"), store: (await import("@/lib/store")).useStore,
    shell: await import("@/lib/pageShell"), bodies: await import("@/lib/pageBodies"), external: await import("@/lib/externalApply") };
}
async function boot(pages: Page[]) {
  const current = await modules(), adapter = await import("@/lib/localDb"), connection = await adapter.openLocalDb();
  await adapter.claimWorkspace(connection, pages.map((p) => current.storage.fullWrite(p)), [["rootOrder", pages.filter((p) => !p.parentId).map((p) => p.id)]], null);
  connection.close(); fake.resetStats(); await current.storage.hydrateWorkspace(); return current;
}
async function reload() {
  (await import("@/lib/localPersistence")).stopLocalPersistence(); vi.resetModules();
  const current = await modules(); await current.storage.hydrateWorkspace(); return current;
}

it("hydrates 200 metadata records with zero body reads and opens only the requested body", async () => {
  const pages = Array.from({ length: 200 }, (_, i) => page({ id: `p${i}`, title: `Page ${i}`, isFavorite: i === 3, blocks: [b("paragraph", { html: `Body ${i}` })] }));
  const { store, shell, bodies } = await boot(pages);
  expect(fake.stats.reads.bodies ?? 0).toBe(0); expect(Object.values(store.getState().pages).every(shell.isShell)).toBe(true);
  expect(store.getState().pages.p3).toMatchObject({ title: "Page 3", isFavorite: true, parentId: null });
  expect(await bodies.ensurePageBody("p3")).toBe("ready"); expect(fake.stats.reads.bodies).toBe(1);
  expect(store.getState().pages.p3.blocks).toEqual(pages[3].blocks); expect(shell.isShell(store.getState().pages.p4)).toBe(true);
});

it("creates, edits, moves, deletes and restores offline across reloads", async () => {
  let { store, storage, bodies } = await boot([page({ id: "parent" })]);
  const id = store.getState().createPage(null, { title: "Local page", blocks: [b("paragraph", { id: "block", html: "Original" })] });
  store.getState().updateBlock(id, "block", { html: "Offline edit" }); await bodies.movePageLoaded(id, "parent");
  store.getState().deletePage(id); expect(store.getState().pages[id].isDeleted).toBe(true);
  await bodies.restorePageLoaded(id); await storage.flushLocalWrites();
  ({ store, storage, bodies } = await reload()); await bodies.ensurePageBody(id);
  expect(store.getState().pages[id]).toMatchObject({ title: "Local page", parentId: "parent", isDeleted: false, blocks: [expect.objectContaining({ html: "Offline edit" })] });
});

it.each(["import", "reset"] as const)("persists %s replacement bodies instead of resurrecting old disk content", async (action) => {
  let { store, storage, bodies } = await boot([page({ id: "p", blocks: [b("paragraph", { html: "Old" })] })]);
  if (action === "import") await bodies.importWorkspaceLoaded({ pages: { p: page({ id: "p", blocks: [b("paragraph", { html: "Imported" })] }) }, rootOrder: ["p"], expanded: {} });
  else await bodies.resetWorkspaceLoaded();
  const expected = store.getState().pages; await storage.flushLocalWrites();
  ({ store, storage, bodies } = await reload()); await bodies.ensurePageBodies(Object.keys(expected));
  expect(store.getState().pages).toEqual(expected);
});

it("keeps the old full-body path when disk is unavailable", async () => {
  const { store, shell, external } = await modules(), remote = page({ id: "remote", blocks: [b()] });
  external.applyingExternal(() => store.getState().applyRemotePages({ pages: { remote } }));
  expect(shell.isShell(store.getState().pages.remote)).toBe(false); expect(store.getState().pages.remote.blocks).toEqual(remote.blocks);
});

it("stores new remote bodies on disk while loaded and opening pages stay loaded", async () => {
  const loaded = page({ id: "loaded", blocks: [b()] }), opening = page({ id: "opening", blocks: [b()] });
  const { store, storage, shell, bodies, external } = await boot([loaded, opening]);
  await bodies.ensurePageBody(loaded.id); bodies.opening.add(opening.id);
  const remote = page({ id: "remote", blocks: [b("paragraph", { html: "Remote body" })] });
  const updates = { remote, loaded: { ...loaded, title: "Updated", blocks: remote.blocks }, opening: { ...opening, blocks: remote.blocks } };
  const transformed = external.applyingExternal(() => store.getState().applyRemotePages({ pages: updates }));
  bodies.opening.delete(opening.id); await storage.flushLocalWrites();
  expect(shell.isShell(store.getState().pages.remote)).toBe(true); expect(shell.isShell(transformed.pages!.remote!)).toBe(true);
  expect(shell.isShell(store.getState().pages.loaded)).toBe(false); expect(shell.isShell(store.getState().pages.opening)).toBe(false);
  for (const id of Object.keys(updates)) expect((await storage.readStoredPage(id))?.page.blocks).toEqual(remote.blocks);
  expect(store.getState().pages.loaded.title).toBe("Updated");
});

it("ignores incoming metadata for loaded pages unless replacement is explicit", async () => {
  const original = page({ id: "p", blocks: [b()] }); const { store, shell, bodies, external } = await boot([original]);
  await bodies.ensurePageBody(original.id); const before = store.getState().pages.p;
  const meta = shell.shellOf({ ...original, title: "Server metadata" });
  const ignored = external.applyingExternal(() => store.getState().applyRemotePages({ pages: { p: meta } }));
  expect(store.getState().pages.p).toBe(before); expect(ignored.pages).toEqual({});
  external.applyingExternal(() => store.getState().applyRemotePages({ pages: { p: meta }, replaceLoaded: true }));
  expect(shell.isShell(store.getState().pages.p)).toBe(true); expect(store.getState().pages.p.title).toBe("Server metadata");
});

it("retains newer shell metadata when a delayed remote body arrives", async () => {
  const old = page({ id: "p", title: "Old title", revision: 2, blocks: [b()] });
  const { store, storage, shell, external } = await boot([old]);
  const newer = shell.shellOf({ ...old, title: "New title", revision: 5 });
  external.applyingExternal(() => store.getState().applyRemotePages({ pages: { p: newer } }));
  external.applyingExternal(() => store.getState().applyRemotePages({ pages: { p: { ...old, revision: 3 } } }));
  expect(store.getState().pages.p).toMatchObject({ title: "New title", revision: 5 });
  expect(shell.isShell(store.getState().pages.p)).toBe(true);
  await storage.flushLocalWrites();
  expect(fake.dump("meta")).toEqual([expect.objectContaining({ title: "New title", revision: 5, bodyRev: 3 })]);
  expect((await storage.readStoredPage("p"))?.stale).toBe(true);
});

it("rebases history with the transformed metadata patch instead of retaining new remote bodies", async () => {
  const { store, shell, external } = await boot([page({ id: "p" })]), history = await import("@/lib/history");
  history.initHistory(); store.getState().updatePage("p", { title: "Local edit" });
  const remote = page({ id: "remote", blocks: [b("paragraph", { html: "Large remote body" })] });
  const patch = external.applyingExternal(() => store.getState().applyRemotePages({ pages: { remote } })); history.rebaseHistory(patch);
  history.undo(); expect(shell.isShell(store.getState().pages.remote)).toBe(true); expect(store.getState().pages.remote.blocks).toEqual([]);
});
