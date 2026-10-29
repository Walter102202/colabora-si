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
