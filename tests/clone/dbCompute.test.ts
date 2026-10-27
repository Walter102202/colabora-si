import { expect, it } from "vitest";
import { aggregate, computeCell, DateValue, displayValue, formatIdValue, formatNumber, isoDay, sortValue } from "@/lib/dbCompute";
import { db, makeFormulaDb, page, prop, row } from "./fixtures";
import type { AggregationFn, DbProperty } from "@/lib/types";

function formula(expr: string, props: DbProperty[] = [], cells: Record<string, unknown> = {}) {
  const { database, formulaProp, theRow, pages } = makeFormulaDb(expr, props, cells);
  return computeCell(theRow, formulaProp, database, pages);
}
const number = prop({ id: "n", name: "N", type: "number" });
const date = prop({ id: "d", name: "D", type: "date" });
const cases: [number, [string, unknown][]][] = [
  [1, [["1 + 2", 3], ["10 - 4", 6], ["6 * 7", 42], ["9 / 2", 4.5], ["7 % 3", 1]]],
  [2, [["2 + 3 * 4", 14], ["(2 + 3) * 4", 20]]],
  [3, [["-5 + 2", -3], ["+3", 3], ["- -4", 4]]],
  [4, [["1 / 3", 0.333333], ["1 / 0", null]]],
  [5, [['"hi"', "hi"], ["'hi'", "hi"], ['"say \\"hi\\""', 'say "hi"']]],
  [6, [["true", true], ["false", false]]], [7, [["", null], ["   ", null]]],
  [8, [['"a" + "b"', "ab"], ['"n=" + 5', "n=5"], ['5 + "!"', "5!"]]],
  [9, [['"" + true', "true"], ['"x" + false', "xfalse"]]], [10, [["2 + 3", 5]]], [11, [['"10" - 4', 6]]],
  [12, [["3 > 2", true], ["3 < 2", false], ["2 >= 2", true], ["1 <= 0", false]]],
  [13, [['"apple" < "banana"', true], ['"b" > "a"', true]]], [14, [['1 == "1"', false], ['1 != "1"', true]]],
  [15, [['1 > "a"', "⚠ Cannot compare number and string"]]],
  [17, [["true and false", false], ["true && false", false], ["true or false", true], ["true || false", true], ["not true", false], ["!false", true]]],
  [19, [["1 != 2", true]]], [20, [['if(true, "yes", "no")', "yes"], ['if(false, "yes", "no")', "no"]]],
  [21, [['if(false, "yes")', null]]], [22, [["if(true)", "⚠ if() needs a condition and two branches"]]],
  [23, [['if("x", 1, 2)', "⚠ Expected true/false, got string"]]],
  [24, [['empty("")', true], ["empty(false)", true], ['empty("x")', false], ["empty(0)", false]]],
  [26, [['concat("a", "b", "c")', "abc"], ["concat()", ""]]],
  [27, [['length("hello")', 5], ['lower("MiXeD")', "mixed"], ['upper("MiXeD")', "MIXED"]]],
  [28, [['contains("hello world", "lo w")', true], ['contains("hello", "z")', false]]],
  [29, [['replace("a-b-c", "-", "+")', "a+b+c"]]], [30, [['slice("abcdef", 2)', "cdef"], ['slice("abcdef", 1, 3)', "bc"]]],
  [31, [["format(12.5)", "12.5"]]], [36, [['dateAdd("2026-03-15", 1, "fortnight")', '⚠ Unknown date unit "fortnights"']]],
  [37, [['dateBetween("2026-03-15", "2026-03-10", "days")', 5], ['dateBetween("2026-03-15", "2025-03-15", "years")', 1], ['dateBetween("2026-03-15", "2026-01-15", "months")', 2], ['dateBetween("2026-07-15", "2026-01-15", "quarters")', 2]]],
  [38, [['formatDate("2026-03-05", "YYYY-MM-DD")', "2026-03-05"], ['formatDate("2026-03-05", "DD/MM/YYYY")', "05/03/2026"], ['formatDate("2026-03-05")', "2026-03-05"]]],
  [41, [["year(true)", "⚠ Expected a date, got boolean"]]],
  [43, [["round(2.6)", 3], ["floor(2.9)", 2], ["ceil(2.1)", 3], ["abs(-4)", 4]]],
  [44, [["sqrt(9)", 3], ["pow(2, 10)", 1024], ["min(3, 1, 2)", 1], ["max(3, 1, 2)", 3]]],
  [47, [['prop("Nope")', '⚠ Unknown property "Nope"'], ["Nope", '⚠ Unknown property "Nope"']]],
  [48, [["bogus(1)", "⚠ Unknown function bogus()"]]], [49, [["1 2", '⚠ Unexpected "2"'], ["@", "⚠ Could not parse formula"]]],
  [50, [["round(1", '⚠ Missing ")" after round(…']]],
];
it.each(cases)("A-5-%i formula expressions", (_id, expressions) => {
  for (const [expression, expected] of expressions) expect(formula(expression), expression).toEqual(expected);
});
it("A-5-16 empty numeric comparisons", () => { expect(formula('prop("N") > 1', [number])).toBe(false); expect(formula('prop("N") < 1', [number])).toBe(false); });
it("A-5-18 operator prefixes in identifiers", () => expect(formula("ordering + 1", [prop({ id: "o", name: "ordering", type: "number" })], { o: 41 })).toBe(42));
it("A-5-25 empty number property", () => expect(formula('empty(prop("N"))', [number])).toBe(true));
it("A-5-32 date parts", () => {
  for (const [fn, expected] of [["year", 2026], ["month", 3], ["day", 15]] as const) expect(formula(`${fn}(prop("D"))`, [date], { d: "2026-03-15" })).toBe(expected);
});
it("A-5-33 date results preserve time and display text", () => {
  const value = formula('dateAdd(prop("D"), 1, "day")', [date], { d: "2026-03-15" }) as DateValue;
  expect(value).toBeInstanceOf(DateValue); expect(new Date(value.time).getUTCDate()).toBe(16); expect(value.toString()).toBe(value.text); expect(String(value)).toContain("2026");
});
it("A-5-34 calendar and duration units", () => {
  for (const [expr, part, expected] of [['dateAdd(D, 1, "month")', "getUTCMonth", 3], ['dateSubtract(D, 1, "year")', "getUTCFullYear", 2025], ['dateAdd(D, 2, "weeks")', "getUTCDate", 29]] as const) {
    expect(new Date((formula(expr, [date], { d: "2026-03-15" }) as DateValue).time)[part]()).toBe(expected);
  }
});
it("A-5-35 singular and plural units", () => expect(formula('dateAdd(D, 1, "day")', [date], { d: "2026-03-15" })).toEqual(formula('dateAdd(D, 1, "days")', [date], { d: "2026-03-15" })));
it("A-5-39 empty date arguments", () => {
  for (const expr of ['dateAdd(D, 1, "day")', "year(D)", 'dateBetween(D, "2026-01-01", "days")']) expect(formula(expr, [date])).toBeNull();
});
it("A-5-40 current date", () => expect(Math.abs((formula("now()") as DateValue).time - Date.now())).toBeLessThan(1000));
it("A-5-42 chained date formulas", () => {
  expect(formula('year(prop("Plus"))', [prop({ id: "start", name: "Start", type: "date" }), prop({ name: "Plus", type: "formula", formula: 'dateAdd(Start, 1, "day")' })], { start: "2026-12-31" })).toBe(2027);
});
it("A-5-45 property names", () => { const p = prop({ id: "s", name: "Score", type: "number" }); for (const expr of ["Score * 2", 'prop("Score") * 2']) expect(formula(expr, [p], { s: 10 })).toBe(20); });
it("A-5-46 property ids", () => expect(formula('prop("n") + 1', [number], { n: 1 })).toBe(2));
it("A-5-51 property coercions", () => {
  const done = prop({ id: "done", name: "Done", type: "checkbox" });
  expect(formula("if(Done, 1, 0)", [done], { done: true })).toBe(1); expect(formula("if(Done, 1, 0)", [done])).toBe(0);
  expect(formula("N + 1", [number], { n: "41" })).toBe(42); expect(formula("N + 1", [number], { n: "abc" })).toBe(1);
});
it("A-5-52 select values in formulas use labels", () => expect(formula('Status == "Done"', [prop({ id: "s", name: "Status", type: "select", options: [{ id: "o1", name: "Done", color: "green" }] })], { s: "o1" })).toBe(true));
it("A-5-53 ids in formulas use prefixes", () => expect(formula("Key", [prop({ id: "key", name: "Key", type: "id", idPrefix: "TASK" })], { key: 7 })).toBe("TASK-7"));
it("A-5-54 creation time in formulas", () => {
  const f = makeFormulaDb('year(prop("Created"))', [prop({ name: "Created", type: "createdTime" })]);
  f.pages[f.theRow.pageId].createdAt = Date.UTC(2021, 5, 1, 12);
  expect(computeCell(f.theRow, f.formulaProp, f.database, f.pages)).toBe(2021);
});
it("A-5-55 title cell falls back to page", () => {
  const r = row({}, "owner"), p = prop({ id: "title" });
  expect(computeCell(r, p, db([p]), { owner: page({ title: "From page" }) })).toBe("From page");
  expect(computeCell({ ...r, cells: { title: "From cell" } }, p, db([p]), {})).toBe("From cell");
});
it("A-5-56 timestamps come from row page", () => {
  const r = row({}, "owner"), pages = { owner: page({ createdAt: 1000, updatedAt: 2000 }) };
  expect(computeCell(r, prop({ type: "createdTime" }), db([]), pages)).toBe(1000);
  expect(computeCell(r, prop({ type: "lastEditedTime" }), db([]), pages)).toBe(2000);
});
function rollup(fn: DbProperty["rollupFn"], text = false, missing = false) {
  const target = prop({ id: "value", type: text ? "text" : "number" }), relation = prop({ id: "relation", type: "relation", relationDbId: "tasksdb" });
  const related = db([target], [row({ value: text ? "a" : 10 }, "t1"), row({ value: text ? "b" : 30 }, "t2"), row({}, "t3")]);
  const p = prop({ type: "rollup", relationPropId: missing ? "nope" : "relation", targetPropId: "value", rollupFn: fn });
  return computeCell(row({ relation: ["t1", "t2", "t3"] }), p, db([relation, p]), { tasksdb: page({ database: related }) });
}
it("A-5-57 rollup counts", () => { expect(rollup("count")).toBe(3); expect(rollup("countValues")).toBe(2); });
it("A-5-58 numeric rollups", () => { for (const [fn, expected] of [["sum", 40], ["average", 20], ["min", 10], ["max", 30]] as const) expect(rollup(fn)).toBe(expected); });
it("A-5-59 text has no numeric extrema", () => { for (const fn of ["average", "min", "max"] as const) expect(rollup(fn, true)).toBeNull(); });
it("A-5-60 original rollup values", () => expect(rollup("showOriginal", true)).toBe("a, b"));
it("A-5-61 missing rollup relation", () => expect(rollup("sum", false, true)).toBeNull());
it("A-5-62 number formats", () => { expect(formatNumber(1234.5)).toBe((1234.5).toLocaleString("en-US")); expect(formatNumber(.25, "percent")).toBe("25%"); expect(formatNumber(3, "dollar")).toBe("$3"); expect(formatNumber(3, "euro")).toBe("€3"); });
it("A-5-63 invalid numbers", () => { expect(formatNumber(NaN)).toBe(""); expect(formatNumber(Infinity)).toBe(""); });
it("A-5-64 rounded number format", () => expect(formatNumber(1 / 3)).toBe((.333333).toLocaleString("en-US")));
it("A-5-65 prefixed ids", () => expect(formatIdValue(prop({ type: "id", idPrefix: "TASK" }), 12)).toBe("TASK-12"));
it("A-5-66 unprefixed and empty ids", () => { for (const prefix of [undefined, "  "]) expect(formatIdValue(prop({ type: "id", idPrefix: prefix }), 12)).toBe("12"); for (const value of [null, ""]) expect(formatIdValue(prop(), value)).toBe(""); });
it("A-5-67 local ISO days", () => { for (const hour of [0, 12]) expect(isoDay(new Date(2026, 2, 15, hour).getTime())).toBe("2026-03-15"); });
const options = [{ id: "a", name: "Red", color: "red" as const }, { id: "b", name: "Blue", color: "blue" as const }];
it("A-5-68 select display", () => { const p = prop({ type: "select", options: [{ id: "o1", name: "Done", color: "green" }] }); expect(displayValue("o1", p)).toBe("Done"); expect(displayValue("missing", p)).toBe(""); });
it("A-5-69 multi select display", () => { const p = prop({ type: "multiSelect", options }); expect(displayValue(["a", "b"], p)).toBe("Red, Blue"); expect(displayValue(["a", "zz"], p)).toBe("Red"); });
it("A-5-70 checkbox display", () => { const p = prop({ type: "checkbox" }); expect(displayValue(true, p)).toBe("✓"); for (const value of [false, null, []]) expect(displayValue(value, p)).toBe(""); });
it("A-5-71 relation display", () => expect(displayValue(["a", "gone"], prop({ type: "relation" }), db([]), { a: page({ title: "Alpha" }) })).toBe("Alpha, Untitled"));
it("A-5-72 currency display", () => expect(displayValue(5, prop({ type: "number", numberFormat: "dollar" }))).toBe("$5"));
it("A-5-73 formula date display", () => expect(displayValue(new DateValue(Date.UTC(2026, 0, 2), "Jan 2, 2026"), prop({ type: "formula" }))).toBe("Jan 2, 2026"));
it("A-5-74 formula number and error display", () => { const p = prop({ type: "formula", numberFormat: "percent" }); expect(displayValue(.5, p)).toBe("50%"); expect(displayValue("⚠ boom", p)).toBe("⚠ boom"); });
it("A-5-75 select sort keys", () => { const p = prop({ id: "s", type: "select", options: [{ id: "z1", name: "Alpha", color: "blue" }, { id: "a1", name: "Zulu", color: "red" }] }); expect(sortValue(row({ s: "z1" }), p, db([p]), {})).toBe("Alpha"); expect(sortValue(row({ s: "a1" }), p, db([p]), {})).toBe("Zulu"); });
it("A-5-76 formula dates sort by timestamp", () => {
  const p = prop({ type: "formula", formula: 'dateAdd(D, 0, "days")' }), database = db([date, p]);
  const march = row({ d: "2026-03-15" }), april = row({ d: "2026-04-15" });
  expect(sortValue(march, p, database, {})).toBeLessThan(sortValue(april, p, database, {}) as number);
  expect(Number(displayValue(computeCell(march, p, database, {}), p))).toBeNaN();
});
it("A-5-77 numbers and empty sort keys", () => { expect(sortValue(row({ n: 42 }), number, db([number]), {})).toBe(42); expect(sortValue(row(), number, db([number]), {})).toBe(""); });
it("A-5-78 multi select sort keys", () => { const p = prop({ id: "s", type: "multiSelect", options }); expect(sortValue(row({ s: ["a"] }), p, db([p]), {})).toBe("Red"); });
function agg(fn: AggregationFn, values: unknown[] = [1, 3, 8, null], patch: Partial<DbProperty> = {}) {
  const p = prop({ id: "value", type: "number", ...patch }), rows = values.map((value) => row({ value }));
  return aggregate(fn, rows, p, db([p], rows), {});
}
it("A-5-79 counts", () => { for (const [fn, expected] of [["count", "4"], ["countValues", "3"], ["countEmpty", "1"], ["countNotEmpty", "3"]] as const) expect(agg(fn)).toBe(expected); });
it("A-5-80 percentages", () => { expect(agg("percentEmpty")).toBe("25%"); expect(agg("percentNotEmpty")).toBe("75%"); });
it("A-5-81 numeric aggregates", () => { for (const [fn, expected] of [["sum", "12"], ["average", "4"], ["median", "3"], ["min", "1"], ["max", "8"], ["range", "7"]] as const) expect(agg(fn)).toBe(expected); });
it("A-5-82 even median", () => expect(agg("median", [1, 4])).toBe((2.5).toLocaleString("en-US")));
it("A-5-83 text numeric aggregates", () => { for (const fn of ["sum", "average", "median", "min", "max", "range"] as const) expect(agg(fn, ["a", "b"], { type: "text" })).toBe(""); });
it("A-5-84 checkbox aggregates", () => { expect(agg("checked", [true, false, null], { type: "checkbox" })).toBe("1"); expect(agg("unchecked", [true, false, null], { type: "checkbox" })).toBe("2"); expect(agg("percentChecked", [true, false, null], { type: "checkbox" })).toBe("33%"); });
it("A-5-85 empty aggregates", () => { expect(agg("none")).toBe(""); expect(agg("percentEmpty", [])).toBe("0%"); });
it("A-5-86 formatted aggregates", () => expect(agg("sum", [2, 3], { numberFormat: "dollar" })).toBe("$5"));
