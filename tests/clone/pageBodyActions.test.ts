// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "@/lib/store";
import { applyingExternal } from "@/lib/externalApply";
import { isShell, shellOf } from "@/lib/pageShell";
import { duplicatePageLoaded, movePageLoaded, restorePageLoaded, ensurePageBody, ensurePageBodies, exportDeps, PAGE_UNAVAILABLE } from "@/lib/pageBodies";
import { fullWrite, readFullWorkspace, startWriter, stopLocalPersistence } from "@/lib/localPersistence";
import { claimWorkspace, openLocalDb, readWorkspace } from "@/lib/localDb";
import { buildDbOps } from "@/lib/dbOps";
import { runAgentAction } from "@/lib/agentActions";
import { pageToHtml } from "@/lib/export";
import { buildGitExport } from "@/lib/gitExport";
import { referencedFileIds } from "@/lib/fileStore";
import MovePageModal from "@/components/MovePageModal";
import TemplateModal from "@/components/TemplateModal";
import SettingsModal from "@/components/SettingsModal";
import { downloadBlob } from "@/lib/export";
import { readZip } from "@/lib/zip";
import * as files from "@/lib/fileStore";
import type { Page } from "@/lib/types";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, db, page, prop, row } from "./fixtures";

vi.mock("@/lib/agentActions", () => ({ runAgentAction: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/export", async (original) => ({ ...await original<typeof import("@/lib/export")>(), downloadBlob: vi.fn() }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.alert = vi.fn(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); stopLocalPersistence(); vi.restoreAllMocks(); vi.clearAllMocks(); });
async function setup(pages: Page[], missing: string[] = [], loaded: string[] = []) {
  stopLocalPersistence(); const fake = installFakeIndexedDb();
  applyingExternal(() => useStore.setState({ pages: Object.fromEntries(pages.map((p) => [p.id, loaded.includes(p.id) ? p : shellOf(p)])), rootOrder: pages.filter((p) => !p.parentId).map((p) => p.id), syncUserId: null, syncWorkspaceId: null, syncedBlocks: {} }));
  const connection = await openLocalDb(); await claimWorkspace(connection, pages.filter((p) => !missing.includes(p.id)).map((p) => fullWrite(p)), [], null);
  startWriter(connection, (await readWorkspace(connection)).epoch); return fake;
}
function family() {
  const child = page({ id: "child", title: "Child", parentId: "database", blocks: [b("paragraph", { html: "Full row body" }), b("file", { fileId: "attachment" })] });
  const saved = row({ title: "Child", notes: "Saved cells" }, child.id); saved.id = "row";
  const properties = [prop({ id: "title", type: "text" }), prop({ id: "notes", name: "Notes", type: "text" })];
  return [page({ id: "database", title: "Source", database: db(properties, [saved]) }), child, page({ id: "destination", title: "Destination", database: db(structuredClone(properties)) })];
}
const mount = (node: React.ReactNode) => act(() => root.render(createElement(MemoryRouter, null, node)));

it("reads a full export without hydrating shells, retains current loaded edits, and includes attachments and Markdown", async () => {
  const pages = family(); await setup(pages, [], ["child"]);
  useStore.getState().updateBlock("child", pages[1].blocks[0].id, { html: "Newest text" });
  const before = useStore.getState().pages;
  const snapshot = await readFullWorkspace(); expect(snapshot.missing).toBe(0);
  expect(Object.keys(snapshot.pages).sort()).toEqual(pages.map((p) => p.id).sort());
  expect(snapshot.pages.child.blocks[0].html).toBe("Newest text"); expect(useStore.getState().pages).toBe(before); expect(isShell(before.database)).toBe(true);
  expect(referencedFileIds(snapshot.pages)).toContain("attachment");
  expect(buildGitExport(snapshot.pages, new Set(), new Date(0)).some((entry) => new TextDecoder().decode(entry.data).includes("Newest text"))).toBe(true);
  expect(JSON.parse(JSON.stringify(snapshot.pages)).database.database.rows).toEqual(pages[0].database!.rows);
});

it("reports missing or stale bodies instead of presenting a complete backup", async () => {
  const pages = family(); await setup(pages, ["child"]);
  expect((await readFullWorkspace()).missing).toBe(1);
  applyingExternal(() => useStore.setState(({ pages }) => ({ pages: { ...pages, database: { ...pages.database, revision: 99 } } })));
  expect((await readFullWorkspace()).missing).toBe(2);
});

it("can export the newest complete memory snapshot even when quota prevents saving it", async () => {
  const pages = family(), fake = await setup(pages, [], ["child"]);
  useStore.getState().updateBlock("child", pages[1].blocks[0].id, { html: "Unsaved due to quota" }); fake.failNext("QuotaExceededError");
  const snapshot = await readFullWorkspace(); expect(snapshot.missing).toBe(0); expect(snapshot.pages.child.blocks[0].html).toBe("Unsaved due to quota");
});

it("Settings refuses a partial download and exports complete JSON and zip with unloaded attachments", async () => {
  const pages = family(); await setup(pages, ["child"]);
  mount(createElement(SettingsModal, { tab: "data", onClose: () => {}, onTabChange: () => {} }));
  const click = async (text: string) => { await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === text)!.click(); }); };
  await click("Export JSON"); expect(downloadBlob).not.toHaveBeenCalled(); expect(host.textContent).toContain("pages aren't on this device yet");
  await setup(pages); await click("Export JSON");
  const json = JSON.parse(await vi.mocked(downloadBlob).mock.calls[0][0].text()); expect(json.pages.child.blocks[0].html).toBe("Full row body");
  vi.spyOn(files, "getFile").mockResolvedValue(new Blob(["attachment bytes"]));
  await click("Export full backup (.zip)");
  const archive = vi.mocked(downloadBlob).mock.calls.at(-1)![0], entries = await readZip(await archive.arrayBuffer());
  expect(entries.some((entry) => entry.name === "files/attachment")).toBe(true);
  expect(entries.find((entry) => entry.name === "workspace.json")?.data).toBeDefined();
});

it("loads an inline database before HTML export so its rows appear", async () => {
  const pages = family(), owner = page({ id: "owner", blocks: [b("database", { pageId: "database" })] });
  await setup([...pages, owner]); await ensurePageBody("owner");
  expect(await ensurePageBodies(exportDeps("owner", useStore.getState().pages))).toBe("ready");
  const current = useStore.getState().pages, html = await pageToHtml(current.owner, current);
  expect(html).toContain("Saved cells"); expect(html).toContain("Child");
});

it.each(["database", "child"])("duplicates an unloaded %s with its body and row relationships", async (id) => {
  await setup(family()); const copy = await duplicatePageLoaded(id); expect(copy).not.toBeNull();
  const pages = useStore.getState().pages;
  if (id === "database") { const rowId = pages[copy!].database!.rows[0].pageId; expect(pages[rowId].blocks[0].html).toBe("Full row body"); expect(pages[rowId].parentId).toBe(copy); }
  else { expect(pages[copy!].blocks[0].html).toBe("Full row body"); expect(pages.database.database!.rows.some((row) => row.pageId === copy && row.cells.notes === "Saved cells")).toBe(true); }
});

it("duplicates an unloaded descendant tree and refuses a partial duplicate", async () => {
  const parent = page({ id: "parent", blocks: [b("paragraph", { html: "Parent text" })] }), child = page({ id: "child", parentId: "parent", blocks: [b("paragraph", { html: "Child text" })] });
  await setup([parent, child], ["child"]); expect(await duplicatePageLoaded("parent")).toBeNull(); expect(Object.keys(useStore.getState().pages)).toHaveLength(2); expect(window.alert).toHaveBeenCalledWith(PAGE_UNAVAILABLE);
  await setup([parent, child]); const copy = await duplicatePageLoaded("parent"); expect(Object.values(useStore.getState().pages).find((page) => page.parentId === copy)?.blocks[0].html).toBe("Child text");
});

it("moves between unloaded databases retaining cells, and stores rowOrigin when moved to root", async () => {
  await setup(family()); await movePageLoaded("child", "destination");
  const moved = useStore.getState().pages; expect(moved.database.database!.rows).toEqual([]); expect(moved.destination.database!.rows[0].cells.notes).toBe("Saved cells");
  await movePageLoaded("child", null); expect(useStore.getState().pages.child.rowOrigin?.row.cells.notes).toBe("Saved cells");
});

it("a missing database rejects a move without changes; incompatible properties reach the modal", async () => {
  await setup(family(), ["database"]); const before = useStore.getState().pages;
  await expect(movePageLoaded("child", "destination")).rejects.toThrow(PAGE_UNAVAILABLE); expect(useStore.getState().pages.child).toBe(before.child);
  const pages = family(); pages[2].database!.properties = []; await setup(pages);
  const closed = vi.fn(); mount(createElement(MovePageModal, { pageId: "child", onClose: closed }));
  const button = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Destination"))!;
  await act(async () => { button.click(); await ensurePageBodies(["database", "destination"]); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("matching"); expect(closed).not.toHaveBeenCalled();
});

it("restores archived cells at their saved position only when the parent is available", async () => {
  const pages = family(); pages[1].isDeleted = true; pages[1].rowOrigin = { databasePageId: "database", row: pages[0].database!.rows[0], index: 0 }; pages[0].database!.rows = [];
  await setup(pages, ["database"]); expect(await restorePageLoaded("child")).toBe(false); expect(useStore.getState().pages.child.isDeleted).toBe(true);
  await setup(pages); expect(await restorePageLoaded("child")).toBe(true); expect(useStore.getState().pages.database.database!.rows[0].cells.notes).toBe("Saved cells"); expect(useStore.getState().pages.child.rowOrigin).toBeUndefined();
});

it("loads a button's agent brief before dispatch, while the loaded path remains synchronous", async () => {
  await setup(family(), [], ["database"]); const seen: string[] = [];
  vi.mocked(runAgentAction).mockImplementation(async (_action, context) => { seen.push(useStore.getState().pages[context!.pageId!].blocks[0].html); });
  const action = { id: "action", kind: "agentTask", mode: "new" } as const, ops = buildDbOps("database");
  ops.runButton("row", action); expect(runAgentAction).not.toHaveBeenCalled(); await ensurePageBody("child"); await Promise.resolve(); expect(seen).toEqual(["Full row body"]);
  ops.runButton("row", action); expect(runAgentAction).toHaveBeenCalledTimes(2);
});

it("loads existing blocks before button insertion or saving a row template", async () => {
  await setup(family(), [], ["database"]); const ops = buildDbOps("database");
  ops.runButton("row", { id: "action", kind: "insertBlocks", blocks: [b("paragraph", { html: "Appended" })] }); await ensurePageBody("child"); await Promise.resolve();
  expect(useStore.getState().pages.child.blocks.map((block) => block.html)).toEqual(["Full row body", "text", "Appended"]);
  await setup(family(), [], ["database"]); ops.saveRowAsTemplate("row", "Saved"); await ensurePageBody("child"); await Promise.resolve();
  expect(useStore.getState().pages.database.database!.rowTemplates?.[0].blocks[0].html).toBe("Full row body");
});

it("loads a shell before applying a selected template", async () => {
  await setup(family()); const closed = vi.fn(); mount(createElement(TemplateModal, { pageId: "child", onClose: closed }));
  const apply = vi.spyOn(useStore.getState(), "applyTemplate");
  await act(async () => { host.querySelector<HTMLButtonElement>(".template-card")!.click(); await ensurePageBody("child"); });
  expect(apply).toHaveBeenCalledOnce(); expect(isShell(useStore.getState().pages.child)).toBe(false); expect(closed).toHaveBeenCalledOnce();
});
