// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TableView from "@/components/database/TableView";
import Cell from "@/components/database/cells/Cell";
import type { DbOps } from "@/lib/dbOps";
import type { Database } from "@/lib/types";
import { VIRTUAL_THRESHOLD } from "@/lib/virtualWindow";
import { databaseTaskValues, subtaskProgress } from "@/lib/databaseTaskValues";
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

const subtaskTasks = {
  job: { row_page_id: "job", state: "working" as const, delegate_agent_id: "lead", parent_task_id: null, updated_at: "2026-11-01T00:00:00Z" },
  first: { row_page_id: "first", state: "done" as const, delegate_agent_id: "worker", parent_task_id: "job", updated_at: "2026-11-01T00:00:00Z" },
  second: { row_page_id: "second", state: "working" as const, delegate_agent_id: "worker", parent_task_id: "job", updated_at: "2026-11-01T00:00:00Z" },
  dropped: { row_page_id: "dropped", state: "cancelled" as const, delegate_agent_id: "worker", parent_task_id: "job", updated_at: "2026-11-01T00:00:00Z" },
};
function mountSubtasks(readOnly: boolean) {
  const lead = prop({ id: "lead", name: "Lead", type: "person" }), status = prop({ id: "state", name: "Status", type: "agentStatus" });
  const source = db([prop({ id: "title", name: "Task" }), lead, status], ["job", "first", "second", "dropped"].map((id) => row({ title: id }, id)));
  const query = databaseTaskValues(source, subtaskTasks, [{ id: "lead", name: "Claude Code", role: "lead" }]);
  act(() => root.render(createElement(TableView, { ops: opsFor(source, readOnly), database: source, queryDatabase: query, view: view({ type: "table" }), rows: query.rows, pages: {} })));
  const cells = (column: number) => [...container.querySelectorAll("tbody tr")].slice(0, 4).map((tr) => tr.children[column] as HTMLElement);
  return { source, query, cells, indents: () => cells(0).map((cell) => (cell.firstElementChild as HTMLElement).style.paddingLeft) };
}
it.each([false, true])("a plan's subtasks hang under the task that started them (read only: %s)", (readOnly) => {
  const table = mountSubtasks(readOnly);
  expect(table.indents()).toEqual(["0px", "18px", "18px", "18px"]);
  expect(container.querySelectorAll('[aria-label="Collapse sub-items"]').length).toBe(1);
});
it("the task's row shows its progress beside the status and stands out from its subtasks", () => {
  const table = mountSubtasks(true);
  expect(table.cells(2)[0].querySelector('[title="1 of 2 subtasks done"]')?.textContent).toBe("1/2");
  expect(table.cells(0)[0].querySelector('[title="1 of 2 subtasks done"]')).toBeNull();
  expect(table.cells(0)[0].querySelector(".font-semibold")).not.toBeNull();
  expect(table.cells(0)[1].querySelector(".font-semibold")).toBeNull();
});
it("subtasks do not repeat the Lead of their task", () => {
  const table = mountSubtasks(true);
  expect(table.cells(1).map((cell) => cell.textContent)).toEqual(["Claude Code", "", "", ""]);
});
it("nesting subtasks changes what is shown, never the stored rows", () => {
  const { source, query } = mountSubtasks(true);
  expect(query.rows.map((r) => r.parentRowId)).toEqual([undefined, query.rows[0].id, query.rows[0].id, query.rows[0].id]);
  expect(source.rows.every((r) => r.parentRowId === undefined)).toBe(true);
});
it("a subtask whose parent row is not in this database stays at the top level", () => {
  const status = prop({ id: "state", name: "Status", type: "agentStatus" });
  const source = db([status], [row({}, "second")]);
  expect(databaseTaskValues(source, subtaskTasks, []).rows[0].parentRowId).toBeUndefined();
});

it("taskless nested rows do not dilute completed subtask progress", () => {
  const status = prop({ id: "state", name: "Status", type: "agentStatus" });
  const source = db([status], [row({}, "job"), ...Array.from({ length: 14 }, (_, i) => ({ ...row({ state: "done" }, `done-${i}`), parentRowId: "job" })), { ...row({}, "placeholder"), parentRowId: "job" }]);
  expect(subtaskProgress(source, source)).toEqual({ job: { done: 14, total: 14 } });
});
it("agent tables do not offer taskless sub-items during setup", () => {
  mountSubtasks(false);
  expect(container.querySelector('[aria-label="New sub-item"]')).toBeNull();
});
it("ordinary tables retain the new sub-item action", () => {
  const database = db([prop({ id: "title", name: "Name" })], [row({ title: "A" }, "a")]);
  act(() => root.render(createElement(TableView, { ops: opsFor(database, false), database, view: view({ type: "table" }), rows: database.rows, pages: {} })));
  expect(container.querySelector('[aria-label="New sub-item"]')).not.toBeNull();
});
