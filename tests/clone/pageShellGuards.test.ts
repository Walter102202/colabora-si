// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useStore, type Store } from "@/lib/store";
import { applyingExternal } from "@/lib/externalApply";
import { isShell, shellOf } from "@/lib/pageShell";
import { ensurePageBody, ensurePageBodies } from "@/lib/pageBodies";
import { fullWrite, flushLocalWrites, persistFull, readStoredPage, startWriter, stopLocalPersistence } from "@/lib/localPersistence";
import { claimWorkspace, openLocalDb, readWorkspace } from "@/lib/localDb";
import { clearHistory, canUndo, initHistory, undo, pushHistory } from "@/lib/history";
import { useIdleSnapshot } from "@/lib/versionSnapshots";
import type { Page } from "@/lib/types";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, db, page, prop, row } from "./fixtures";

let fake: ReturnType<typeof installFakeIndexedDb>;
const original = () => page({ id: "p", revision: 2, blocks: [b("paragraph", { id: "first", html: "First" }), b("paragraph", { id: "keep", html: "Keep me" })] });
async function setup(full: Page[] = [original()], loaded: string[] = []) {
  stopLocalPersistence(); fake = installFakeIndexedDb();
  applyingExternal(() => useStore.setState({ pages: Object.fromEntries(full.map((p) => [p.id, loaded.includes(p.id) ? p : shellOf(p)])), rootOrder: full.filter((p) => !p.parentId).map((p) => p.id), syncUserId: "person", syncWorkspaceId: "workspace", expanded: {}, syncedBlocks: {}, reminders: [] }));
  const connection = await openLocalDb(); await claimWorkspace(connection, full.map((p) => fullWrite(p)), [], null);
  startWriter(connection, (await readWorkspace(connection)).epoch); fake.resetStats(); clearHistory();
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.alert = vi.fn(); });
afterEach(() => { stopLocalPersistence(); clearHistory(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("deduplicates body reads and hydration preserves newer metadata without a write or undo step", async () => {
  initHistory(); await setup();
  applyingExternal(() => useStore.setState(({ pages }) => ({ pages: { p: { ...pages.p, title: "New title" } } })));
  await flushLocalWrites(); fake.resetStats();
  expect(await Promise.all([ensurePageBody("p"), ensurePageBody("p")])).toEqual(["ready", "ready"]);
  expect(fake.stats.reads.bodies).toBe(1); expect(isShell(useStore.getState().pages.p)).toBe(false);
  expect(useStore.getState().pages.p.title).toBe("New title"); expect(useStore.getState().pages.p.blocks).toEqual(original().blocks);
  await flushLocalWrites(); expect(fake.stats.puts).toEqual({}); expect(canUndo()).toBe(false);
  expect(await ensurePageBody("p")).toBe("ready"); expect(fake.stats.reads.bodies).toBe(1);
});

it("prefers a pending full body to the disk and reports stale disk revisions", async () => {
  await setup(); const newer = { ...original(), revision: 3, blocks: [b("paragraph", { id: "new", html: "Pending" })] };
  persistFull([newer]); expect((await readStoredPage("p"))?.page.blocks[0].html).toBe("Pending");
  expect(fake.stats.reads.bodies ?? 0).toBe(0); await flushLocalWrites();
  applyingExternal(() => useStore.setState(({ pages }) => ({ pages: { p: { ...pages.p, revision: 4 } } })));
  expect((await readStoredPage("p"))?.stale).toBe(true);
  expect(await ensurePageBody("p")).toBe("ready"); expect(useStore.getState().pages.p.blocks[0].html).toBe("Pending");
});

it("reports unavailable without manufacturing a body when neither local nor cloud data exists", async () => {
  await setup([]); applyingExternal(() => useStore.setState({ pages: { p: shellOf(original()) } }));
  expect(await ensurePageBodies(["p", "missing"])).toBe("unavailable");
  expect(isShell(useStore.getState().pages.p)).toBe(true); expect(await readStoredPage("p")).toBeNull();
});

it("a delayed body load and edit cannot cross into another account with the same page id", async () => {
  await setup(); const storage = await import("@/lib/localPersistence");
  let finish!: (value: Awaited<ReturnType<typeof readStoredPage>>) => void;
  vi.spyOn(storage, "readStoredPage").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  useStore.getState().updateBlock("p", "first", { html: "Account A edit" });
  const loading = ensurePageBody("p"), next = shellOf({ ...original(), title: "Account B page" });
  applyingExternal(() => useStore.setState({ pages: { p: next }, syncUserId: "other-person", syncWorkspaceId: "other-workspace" }));
  finish({ page: original(), stale: false }); expect(await loading).toBe("unavailable"); await Promise.resolve();
  expect(useStore.getState().pages.p).toBe(next); expect(isShell(useStore.getState().pages.p)).toBe(true);
  expect(window.alert).not.toHaveBeenCalled();
});

const mutations: [string, (s: Store) => unknown, (p: Page) => void][] = [
  ["updatePage title", (s) => s.updatePage("p", { title: "Renamed" }), (p) => expect(p.title).toBe("Renamed")],
  ["toggleFavorite", (s) => s.toggleFavorite("p"), (p) => expect(p.isFavorite).toBe(true)],
  ["deletePage", (s) => s.deletePage("p"), (p) => expect(p.isDeleted).toBe(true)],
  ["restorePage", (s) => s.restorePage("p"), (p) => expect(p.isDeleted).toBe(false)],
  ["movePage", (s) => s.movePage("p", "target"), (p) => expect(p.parentId).toBe("target")],
  ["setBlocks", (s) => s.setBlocks("p", [b("paragraph", { id: "keep", html: "Keep me" })]), (p) => expect(p.blocks).toHaveLength(1)],
  ["updateBlock", (s) => s.updateBlock("p", "first", { html: "Edited" }), (p) => expect(p.blocks[0].html).toBe("Edited")],
  ["insertBlock", (s) => s.insertBlock("p", "first", { html: "Inserted" }), (p) => expect(p.blocks).toHaveLength(3)],
  ["deleteBlock", (s) => s.deleteBlock("p", "first"), (p) => expect(p.blocks).toHaveLength(1)],
  ["moveBlock", (s) => s.moveBlock("p", 0, 1), (p) => expect(p.blocks[1].id).toBe("first")],
  ["addComment", (s) => s.addComment("p", "Comment"), (p) => expect(p.comments?.[0].body).toBe("Comment")],
  ["saveVersion", (s) => s.saveVersion("p"), (p) => expect(p.versions?.[0].blocks).toEqual(original().blocks)],
];
it.each(mutations)("%s never replaces a stored body with an unloaded placeholder", async (_name, run, check) => {
  await setup([original(), page({ id: "target" })]); run(useStore.getState());
  await ensurePageBody("p"); await flushLocalWrites();
  const stored = (await readStoredPage("p"))!.page;
  expect(stored.blocks.some((block) => block.id === "keep" && block.html === "Keep me")).toBe(true); check(stored);
});

function family() {
  const child = { ...original(), parentId: "database" }, saved = row({ title: "Row", files: [{ fileId: "attachment" }] }, "p"); saved.id = "row";
  return [page({ id: "database", database: db([prop({ id: "title", type: "text" }), prop({ id: "files", type: "files" })], [saved]) }), child];
}
it.each(["deletePage", "updatePage"] as const)("%s loads the row's parent database before using its rows", async (action) => {
  await setup(family());
  if (action === "deletePage") useStore.getState().deletePage("p"); else useStore.getState().updatePage("p", { title: "Renamed" });
  await ensurePageBody("database"); await Promise.resolve(); await flushLocalWrites();
  const current = useStore.getState(); expect(isShell(current.pages.database)).toBe(false);
  if (action === "deletePage") { expect(current.pages.database.database!.rows).toEqual([]); expect(current.pages.p.rowOrigin?.row.cells.files).toEqual([{ fileId: "attachment" }]); }
  else expect(current.pages.database.database!.rows[0].cells.title).toBe("Renamed");
  expect((await readStoredPage("p"))?.page.blocks).toEqual(original().blocks);
});

it.each(["deleteRow", "deleteRows", "updateCell", "updateCells", "moveRows"] as const)("%s on a loaded database preserves unloaded row bodies", async (action) => {
  const pages = family(); pages[0].database!.rows.push({ id: "other-row", pageId: "other", cells: { title: "Other" } });
  await setup(pages, ["database"]); const s = useStore.getState();
  if (action === "deleteRow") s.deleteRow("database", "row");
  else if (action === "deleteRows") s.deleteRows("database", ["row"]);
  else if (action === "updateCell") s.updateCell("database", "row", "title", "Renamed");
  else if (action === "updateCells") s.updateCells("database", ["row"], "title", "Renamed");
  else { s.moveRows("database", ["row"], "other-row", "after"); expect(useStore.getState().pages.database.database!.rows.map((r) => r.id)).toEqual(["other-row", "row"]); }
  await flushLocalWrites(); expect((await readStoredPage("p"))?.page.blocks).toEqual(original().blocks);
});

it("rejects unloaded database actions without inventing rows or applying a template", async () => {
  await setup(family()); const s = useStore.getState(), before = s.pages;
  expect(s.addRow("database")).toBe(""); expect(s.addRowFromTemplate("database", "template")).toBe("");
  s.updateCell("database", "row", "title", "Wrong"); s.updateCells("database", ["row"], "title", "Wrong"); s.deleteRow("database", "row"); s.deleteRows("database", ["row"]);
  s.applyTemplate("p", { title: "Overwrite", icon: null, blocks: [] });
  expect(useStore.getState().pages).toBe(before); await flushLocalWrites(); expect(fake.stats.puts).toEqual({});
});

it("loads updatePage body patches before applying them and keeps the loaded marker", async () => {
  await setup(); useStore.getState().updatePage("p", { blocks: [b("paragraph", { html: "Imported body" })] });
  await ensurePageBody("p"); await Promise.resolve(); await flushLocalWrites();
  expect(isShell(useStore.getState().pages.p)).toBe(false); expect((await readStoredPage("p"))?.page.blocks[0].html).toBe("Imported body");
});

it("movePage throws synchronously if either database is unloaded and leaves state untouched", async () => {
  const pages = family(); await setup([...pages, page({ id: "destination", database: db([]) })]);
  const before = useStore.getState().pages;
  expect(() => useStore.getState().movePage("p", null)).toThrow("page_not_loaded");
  expect(() => useStore.getState().movePage("p", "destination")).toThrow("page_not_loaded"); expect(useStore.getState().pages).toBe(before);
  await ensurePageBody("database"); expect(() => useStore.getState().movePage("p", "destination")).toThrow("page_not_loaded");
});

it("does not restore a row into an unloaded database header or discard its archived cells", async () => {
  const [parent, child] = family(); const saved = parent.database!.rows[0];
  child.isDeleted = true; child.rowOrigin = { databasePageId: parent.id, row: saved, index: 0 }; parent.database!.rows = [];
  await setup([parent, child]); useStore.getState().restorePage("p");
  expect(useStore.getState().pages.database.database!.rows).toEqual([]); expect(useStore.getState().pages.p.rowOrigin?.row).toEqual(saved);
});

it("refuses duplicates with unloaded descendants or parent databases, and empty row templates", async () => {
  const [parent, child] = family(); await setup([parent, child], ["p"]);
  expect(useStore.getState().duplicatePage("p")).toBeNull();
  await setup([parent, child], ["database"]); expect(useStore.getState().duplicatePage("database")).toBeNull();
  useStore.getState().saveRowAsTemplate("database", "row", "Saved"); expect(useStore.getState().pages.database.database!.rowTemplates).toBeUndefined();
});

it("undo retains an already-loaded body while taking metadata from the earlier shell snapshot", async () => {
  await setup(); const target = useStore.getState();
  await ensurePageBody("p"); const body = useStore.getState().pages.p.blocks;
  applyingExternal(() => useStore.getState().updatePage("p", { title: "Changed" }));
  pushHistory({ pages: target.pages, rootOrder: target.rootOrder, syncedBlocks: target.syncedBlocks }); undo();
  expect(isShell(useStore.getState().pages.p)).toBe(false); expect(useStore.getState().pages.p.blocks).toBe(body); expect(useStore.getState().pages.p.title).toBe(target.pages.p.title);
});

it("loading a shell does not schedule an idle version", async () => {
  await setup(); vi.useFakeTimers(); const host = document.createElement("div"), root = createRoot(host);
  const save = vi.spyOn(useStore.getState(), "saveVersion");
  function Observer() { useIdleSnapshot("p"); return null; }
  await act(async () => { root.render(createElement(Observer)); });
  await act(async () => { await ensurePageBody("p"); });
  await vi.advanceTimersByTimeAsync(31_000); await act(async () => root.unmount()); expect(save).not.toHaveBeenCalled();
});
