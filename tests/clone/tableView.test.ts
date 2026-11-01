// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TableView from "@/components/database/TableView";
import Cell from "@/components/database/cells/Cell";
import type { DbOps } from "@/lib/dbOps";
import type { Database } from "@/lib/types";
import { VIRTUAL_THRESHOLD } from "@/lib/virtualWindow";
import { db, prop, row, view } from "./fixtures";
import { buildDbOps } from "@/lib/dbOps";
import { useStore } from "@/lib/store";
import { initHistory, undo } from "@/lib/history";

// happy-dom lays nothing out: every box is 0 px high, so the measured window is the overscan alone. The claims here are
// structural (windowed or not, spacer present or not, indices), not pixel counts.
const opsFor = (database: Database, readOnly: boolean, updateCell = vi.fn()): DbOps => new Proxy({} as DbOps, {
  get: (_, key) => key === "readOnly" ? readOnly : key === "locked" ? false : key === "database" ? database : key === "pageId" ? "pg" : key === "updateCell" ? updateCell : () => undefined,
});
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function mountTable(count: number) {
  const rows = Array.from({ length: count }, (_, i) => row({ title: `Row ${i + 1}` }, `r${i + 1}`));
  const database = db([prop({ id: "title", name: "Name" })], rows);
  act(() => root.render(createElement(TableView, { ops: opsFor(database, true), database, view: view({ type: "table" }), rows, pages: {} })));
  return { rows: () => container.querySelectorAll("tbody tr:not([aria-hidden])"), spacers: () => container.querySelectorAll("tbody tr[aria-hidden]") };
}

it("VW-7 a table above the threshold mounts a window of rows, a spacer for the rest and row indices", () => {
  const t = mountTable(VIRTUAL_THRESHOLD + 1);
  expect(t.rows().length).toBeGreaterThan(0);
  expect(t.rows().length).toBeLessThan(VIRTUAL_THRESHOLD + 1);
  expect(t.spacers().length).toBe(1);
  expect(container.querySelector("table")?.getAttribute("aria-rowcount")).toBe(String(VIRTUAL_THRESHOLD + 1));
  expect(t.rows()[0].getAttribute("aria-rowindex")).toBe("2"); // the header row is 1
});
it("VW-8 a table at the threshold renders every row and no spacer", () => {
  const t = mountTable(VIRTUAL_THRESHOLD);
  expect(t.rows().length).toBe(VIRTUAL_THRESHOLD);
  expect(t.spacers().length).toBe(0);
});
it("VW-9 a text cell that unmounts with a pending edit commits it", () => {
  const database = db([prop({ id: "title", name: "Name" }), prop({ id: "notes", name: "Notes", type: "text" })], [row({ title: "A", notes: "" }, "r1")]);
  const updateCell = vi.fn();
  act(() => root.render(createElement(Cell, { ops: opsFor(database, false, updateCell), database, row: database.rows[0], property: database.properties[1], pages: {} })));
  const input = container.querySelector("input")!;
  input.value = "typed, not yet blurred";
  act(() => root.render(null)); // the row scrolled out of the window: no blur is fired for a removed input
  expect(updateCell).toHaveBeenCalledWith(database.rows[0].id, "notes", "typed, not yet blurred");
});

it("selects a range, removes filtered selections, and selects rows beyond the virtual window", () => {
  const rows = Array.from({ length: VIRTUAL_THRESHOLD + 20 }, (_, i) => row({ title: `Item ${i}` }, `page-${i}`));
  const database = db([prop({ id: "title", name: "Name" })], rows), currentView = view(), ops = opsFor(database, false);
  const render = (visible = rows) => act(() => root.render(createElement(TableView, { ops, database, view: currentView, rows: visible, pages: {} })));
  const select = (title: string, shift = false) => act(() => container.querySelector<HTMLInputElement>(`input[aria-label="Select row ${title}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: shift })));
  render(); select("Item 0"); select("Item 2", true);
  expect(container.querySelector('[role="toolbar"]')!.textContent).toContain("3 selected");
  render([rows[2], rows[3]]);
  expect(container.querySelector('[role="toolbar"]')!.textContent).toContain("1 selected");
  render(); expect(container.querySelector('[role="toolbar"]')!.textContent).toContain("1 selected");
  act(() => container.querySelector<HTMLInputElement>('[aria-label="Select all visible rows"]')!.click());
  expect(container.querySelector('[role="toolbar"]')!.textContent).toContain(`${rows.length} selected`);
  expect(container.querySelectorAll('tbody tr:not([aria-hidden])').length).toBeLessThan(rows.length);
});

it("keyboard row movement and bulk trash each undo as one action, preserving restored cells", () => {
  initHistory();
  const store = useStore.getState(), pageId = store.createDatabasePage();
  const ids = ["Alpha", "Beta", "Gamma"].map((title) => store.addRow(pageId, { cells: { title } }));
  const ops = buildDbOps(pageId);
  function LiveTable() {
    const pages = useStore((s) => s.pages), database = pages[pageId].database!;
    return createElement(TableView, { ops, database, view: database.views[0], rows: database.rows, pages });
  }
  act(() => root.render(createElement(LiveTable)));
  act(() => container.querySelector('[aria-label="Move row Alpha"]')!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, altKey: true, key: "ArrowDown" })));
  expect(ops.database.rows.map((r) => r.id)).toEqual([ids[1], ids[0], ids[2]]);
  act(() => undo()); expect(ops.database.rows.map((r) => r.id)).toEqual(ids);
  act(() => container.querySelector<HTMLInputElement>('[aria-label="Select all visible rows"]')!.click());
  act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "Move to trash")!.click());
  expect(ops.database.rows).toHaveLength(0);
  act(() => undo()); expect(ops.database.rows.map((r) => r.cells.title)).toEqual(["Alpha", "Beta", "Gamma"]);
});

it("does not offer mutating bulk actions in read-only mode or allow dragging sorted rows", () => {
  const rows = [row({ title: "A" })], database = db([prop({ id: "title", name: "Name" })], rows);
  act(() => root.render(createElement(TableView, { ops: opsFor(database, true), database, view: view(), rows, pages: {} })));
  act(() => container.querySelector<HTMLInputElement>('[aria-label="Select all visible rows"]')!.click());
  expect(container.textContent).not.toContain("Move to trash"); expect(container.querySelector(".row-grip")).toBeNull();
  act(() => root.render(createElement(TableView, { ops: opsFor(database, false), database, view: view({ sorts: [{ propertyId: "title", direction: "asc" }] }), rows, pages: {} })));
  expect(container.querySelector(".row-grip")!.getAttribute("draggable")).toBe("false");
});
