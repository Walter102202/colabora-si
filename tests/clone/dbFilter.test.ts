import { expect, it } from "vitest";
import { defaultOperator, filterRows, matchCondition, NO_VALUE_OPS, operatorsFor, rowColorKey } from "@/lib/dbFilter";
import { computeCell, DateValue } from "@/lib/dbCompute";
import { db, page, prop, row, view } from "./fixtures";
import type { DbProperty, FilterOperator, PropertyType } from "@/lib/types";

const operators: [number, PropertyType[], FilterOperator[]][] = [
  [87, ["number", "rollup", "formula"], ["is", "isNot", "gt", "lt", "isEmpty", "isNotEmpty"]],
  [88, ["select", "status"], ["is", "isNot", "isEmpty", "isNotEmpty"]],
  [89, ["multiSelect"], ["contains", "notContains", "isEmpty", "isNotEmpty"]],
  [90, ["checkbox"], ["checked", "unchecked"]],
  [91, ["date", "createdTime", "lastEditedTime"], ["is", "isNot", "gt", "lt", "isEmpty", "isNotEmpty"]],
  [92, ["relation", "files"], ["isEmpty", "isNotEmpty"]],
  [93, ["id"], ["is", "isNot", "contains", "notContains", "gt", "lt"]],
  [94, ["text", "url", "email", "phone", "person"], ["is", "isNot", "contains", "notContains", "isEmpty", "isNotEmpty"]],
];
it.each(operators)("A-5-%i available filter operators", (_id, types, expected) => { for (const type of types) expect(operatorsFor(type)).toEqual(expected); });
it("A-5-95 default operators", () => { expect(defaultOperator("checkbox")).toBe("checked"); expect(defaultOperator("multiSelect")).toBe("contains"); expect(defaultOperator("text")).toBe("is"); });
it("A-5-96 operators without operands", () => expect([...NO_VALUE_OPS].sort()).toEqual(["checked", "isEmpty", "isNotEmpty", "unchecked"]));
function match(type: PropertyType, cell: unknown, operator: FilterOperator, value?: string, patch: Partial<DbProperty> = {}) {
  const p = prop({ id: "p", type, ...patch }), r = row({ p: cell }, "owner");
  return matchCondition(r, { id: "condition", propertyId: p.id, operator, value }, db([p]), { owner: page({ createdAt: new Date(2026, 4, 10, 12).getTime() }) });
}
it("A-5-97 empty text", () => { for (const cell of [undefined, "", []]) expect(match("text", cell, "isEmpty")).toBe(true); expect(match("text", "x", "isEmpty")).toBe(false); expect(match("text", "x", "isNotEmpty")).toBe(true); });
it("A-5-98 checkbox conditions", () => { expect(match("checkbox", true, "checked")).toBe(true); expect(match("checkbox", false, "checked")).toBe(false); expect(match("checkbox", undefined, "unchecked")).toBe(true); expect(match("checkbox", true, "unchecked")).toBe(false); });
it("A-5-99 removed property leaves rows visible", () => expect(matchCondition(row(), { id: "c", propertyId: "gone", operator: "is", value: "x" }, db([]), {})).toBe(true));
it("A-5-100 empty operands are inactive", () => { for (const type of ["text", "number", "date", "id", "select"] as const) for (const value of ["", undefined]) expect(match(type, "5", "is", value)).toBe(true); });
it("A-5-101 numeric comparison", () => { for (const [op, value, expected] of [["is", "5", true], ["isNot", "5", false], ["gt", "3", true], ["lt", "3", false]] as const) expect(match("number", 5, op, value)).toBe(expected); });
it("A-5-102 numeric strings", () => expect(match("number", "5", "is", "5")).toBe(true));
it("A-5-103 empty numeric cells", () => { expect(match("number", undefined, "is", "5")).toBe(false); expect(match("number", undefined, "isNot", "5")).toBe(true); expect(match("number", undefined, "gt", "5")).toBe(false); });
it("A-5-104 invalid numeric operand", () => expect(match("number", 5, "is", "abc")).toBe(true));
it("A-5-105 numeric formula comparison", () => { for (const [op, value, expected] of [["is", "5", true], ["gt", "4", true], ["lt", "4", false]] as const) expect(match("formula", null, op, value, { formula: "2 + 3" })).toBe(expected); });
it("A-5-106 textual formula comparison", () => { for (const [op, value] of [["is", "Hello World"], ["contains", "LO WO"], ["notContains", "zzz"], ["isNot", "other"]] as const) expect(match("formula", null, op, value, { formula: '"hello world"' })).toBe(true); });
it("A-5-107 textual formula ordering", () => { expect(match("formula", null, "gt", "a", { formula: '"hello world"' })).toBe(true); expect(match("formula", null, "lt", "z", { formula: '"hello world"' })).toBe(true); });
function dateFormula(op: FilterOperator, value: string) {
  const date = prop({ id: "d", name: "D", type: "date" }), f = prop({ id: "f", type: "formula", formula: 'dateAdd(prop("D"), 0, "days")' });
  return matchCondition(row({ d: "2026-04-15" }), { id: "c", propertyId: "f", operator: op, value }, db([date, f]), {});
}
it("A-5-108 date formula comparisons", () => { for (const [op, value, expected] of [["is", "2026-04-15", true], ["isNot", "2026-04-15", false], ["gt", "2026-01-01", true], ["lt", "2026-01-01", false], ["lt", "2026-12-31", true]] as const) expect(dateFormula(op, value)).toBe(expected); });
it("A-5-109 timestamp operand for formula date", () => expect(dateFormula("gt", "2026-01-01T00:00:00Z")).toBe(true));
it("A-5-110 text search within formula date", () => expect(dateFormula("contains", "2026")).toBe(true));
it("Date formulas search English display text without numeric coercion", () => {
  const date = prop({ id: "d", name: "D", type: "date" });
  const formula = prop({ id: "f", type: "formula", formula: 'dateAdd(D, 0, "days")' });
  const database = db([date, formula]), theRow = row({ d: "2026-04-15" });
  const value = computeCell(theRow, formula, database, {});
  expect(value).toBeInstanceOf(DateValue);
  expect(String(value)).toBe("Apr 15, 2026");
  for (const target of ["2026", "15"]) {
    expect(matchCondition(theRow, { id: "c", propertyId: "f", operator: "contains", value: target }, database, {})).toBe(true);
    expect(matchCondition(theRow, { id: "c", propertyId: "f", operator: "notContains", value: target }, database, {})).toBe(false);
  }
  expect(computeCell(theRow, { ...formula, formula: 'formatDate(D, "MMM")' }, database, {})).toBe("Apr");
});
it("A-5-111 date comparisons", () => { for (const [op, value, expected] of [["is", "2026-05-10", true], ["isNot", "2026-05-10", false], ["gt", "2026-05-09", true], ["lt", "2026-05-11", true]] as const) expect(match("date", "2026-05-10", op, value)).toBe(expected); });
it("A-5-112 date and time cell compares by day", () => expect(match("date", "2026-05-10T18:30", "is", "2026-05-10")).toBe(true));
it("A-5-113 created time compares by local day", () => expect(match("createdTime", undefined, "is", "2026-05-10")).toBe(true));
it("A-5-114 multi select membership", () => { expect(match("multiSelect", ["a", "b"], "contains", "a")).toBe(true); expect(match("multiSelect", ["a", "b"], "contains", "z")).toBe(false); expect(match("multiSelect", ["a"], "notContains", "z")).toBe(true); expect(match("multiSelect", undefined, "contains", "a")).toBe(false); });
it("A-5-115 select ids are case sensitive", () => { expect(match("select", "Opt1", "is", "Opt1")).toBe(true); expect(match("select", "Opt1", "is", "opt1")).toBe(false); expect(match("select", "Opt1", "isNot", "Other")).toBe(true); });
it("A-5-116 text ignores case", () => { for (const [op, value] of [["is", "hello"], ["contains", "ELL"], ["notContains", "zzz"]] as const) expect(match("text", "Hello", op, value)).toBe(true); });
it("A-5-117 id prefix comparisons", () => { for (const [op, value] of [["is", "TASK-3"], ["is", "task-3"], ["is", "3"], ["isNot", "TASK-4"], ["contains", "ask-"], ["notContains", "zz"]] as const) expect(match("id", 3, op, value, { idPrefix: "TASK" })).toBe(true); });
it("A-5-118 id ordering", () => { expect(match("id", 10, "gt", "TASK-3", { idPrefix: "TASK" })).toBe(true); expect(match("id", 10, "lt", "3", { idPrefix: "TASK" })).toBe(false); });
it("A-5-119 id without digits is inactive", () => expect(match("id", 10, "gt", "TASK-", { idPrefix: "TASK" })).toBe(true));
it("A-5-120 empty id ordering", () => expect(match("id", undefined, "gt", "1")).toBe(false));
const status = prop({ id: "status", type: "select" }), score = prop({ id: "score", type: "number" });
const rows = [row({ status: "done", score: 10 }), row({ status: "todo", score: 10 }), row({ status: "done", score: 1 })];
const database = db([status, score], rows);
it("A-5-121 no filters preserves row order", () => { expect(filterRows(rows, view(), database, {})).toBe(rows); expect(filterRows(rows, view({ filters: undefined }), database, {})).toBe(rows); });
it("A-5-122 AND filters", () => expect(filterRows(rows, view({ filters: [{ id: "1", propertyId: "status", operator: "is", value: "done" }, { id: "2", propertyId: "score", operator: "gt", value: "5" }] }), database, {})).toEqual([rows[0]]));
it("A-5-123 OR filters", () => expect(filterRows(rows, view({ filterConjunction: "or", filters: [{ id: "1", propertyId: "status", operator: "is", value: "todo" }, { id: "2", propertyId: "score", operator: "lt", value: "5" }] }), database, {})).toEqual([rows[1], rows[2]]));
it("A-5-124 absent color rules", () => expect(rowColorKey(rows[0], view(), database, {})).toBeNull());
it("A-5-125 first matching color", () => expect(rowColorKey(rows[0], view({ colorRules: [{ id: "1", propertyId: "status", operator: "is", value: "todo", color: "red" }, { id: "2", propertyId: "status", operator: "is", value: "done", color: "green" }, { id: "3", propertyId: "status", operator: "isNotEmpty", color: "blue" }] }), database, {})).toBe("green"));
it("A-5-126 inactive colors are skipped", () => expect(rowColorKey(rows[0], view({ colorRules: [{ id: "1", propertyId: "status", operator: "is", value: "", color: "red" }, { id: "2", propertyId: "status", operator: "is", value: "done", color: "green" }] }), database, {})).toBe("green"));
it("A-5-127 empty color rules", () => { const v = view({ colorRules: [{ id: "1", propertyId: "status", operator: "isEmpty", color: "gray" }] }); expect(rowColorKey(row(), v, database, {})).toBe("gray"); expect(rowColorKey(rows[0], v, database, {})).toBeNull(); });


import { databaseTaskValues } from "@/lib/databaseTaskValues";
import { groupRows } from "@/lib/dbCompute";
it("agent views filter and group authoritative task states without changing stored cells", () => {
  const status = prop({ id: "state", name: "Status", type: "agentStatus" }), worker = prop({ id: "worker", type: "agentDelegate" });
  const source = db([status, worker], [row({ state: "done" }, "queued-page"), row({}, "review-page"), row({}, "plain-page")]);
  const query = databaseTaskValues(source, {
    queued: { row_page_id: "queued-page", state: "queued", delegate_agent_id: "worker", parent_task_id: null, updated_at: "2026-10-27T00:00:00Z" },
    old: { row_page_id: "review-page", state: "done", delegate_agent_id: "old-worker", parent_task_id: null, updated_at: "2026-10-27T01:00:00Z" },
    review: { row_page_id: "review-page", state: "ready_for_review", delegate_agent_id: "worker", parent_task_id: null, updated_at: "2026-10-27T00:00:00Z" },
  }, []);
  const waiting = view({ filters: [{ id: "f", propertyId: "state", operator: "is", value: "ready_for_review" }] });
  expect(filterRows(query.rows, waiting, query, {}).map((r) => r.pageId)).toEqual(["review-page"]);
  const groups = groupRows(query.rows, view({ type: "board", groupBy: "state" }), query, {});
  expect(groups.find((g) => g.key === "queued")?.rows[0].pageId).toBe("queued-page");
  expect(groups.find((g) => g.key === "ready_for_review")?.rows[0].pageId).toBe("review-page");
  expect(groups.find((g) => g.key === null)?.rows[0].pageId).toBe("plain-page");
  expect(query.rows[1].cells.worker).toBe("worker");
  expect(source.properties[0].type).toBe("agentStatus");
  expect(source.rows[0].cells).toEqual({ state: "done" });
});

it("agent task Lead cells display the assigned lead name without changing stored people", () => {
  const lead = prop({ id: "lead", name: "Lead", type: "person" }), status = prop({ id: "state", type: "agentStatus" });
  const source = db([lead, status], [row({ lead: "stale" }, "parent-page"), row({}, "child-page"), row({}, "worker-page"), row({}, "missing-parent-page"), row({}, "plain-page")]);
  const task = { state: "queued" as const, delegate_agent_id: "worker", parent_task_id: null, updated_at: "2026-10-28T00:00:00Z" };
  const tasks = {
    parent: { ...task, row_page_id: "parent-page", delegate_agent_id: "lead-agent" },
    child: { ...task, row_page_id: "child-page", parent_task_id: "parent" },
    worker: { ...task, row_page_id: "worker-page" },
    missing: { ...task, row_page_id: "missing-parent-page", parent_task_id: "not-loaded" },
  };
  const agents = [{ id: "lead-agent", name: "Claude Code", role: "lead" as const }, { id: "worker", name: "Codex", role: "worker" as const }];
  const query = databaseTaskValues(source, tasks, agents);
  expect(query.rows.map((r) => computeCell(r, lead, query, {}))).toEqual(["Claude Code", "Claude Code", null, null, null]);
  expect(filterRows(query.rows, view({ filters: [{ id: "f", propertyId: "lead", operator: "contains", value: "Claude" }] }), query, {}).map((r) => r.pageId)).toEqual(["parent-page", "child-page"]);
  expect(source.rows[0].cells.lead).toBe("stale");
  const ordinary = db([lead], source.rows);
  expect(databaseTaskValues(ordinary, tasks, agents)).toBe(ordinary);
});
