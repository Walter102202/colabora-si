import type { Actor, AggregationFn, Database, DbProperty, DbRow, DbView, Page, PropertyType } from "./types.ts";

export type FormulaValue = number | string | boolean | Date | null;
export interface ComputeContext { members?: Actor[]; agents?: Actor[] }
export class DateValue {
  constructor(readonly time: number, readonly text: string) {}
  toString(): string { return this.text; }
  valueOf(): number { return this.time; }
}
class FormulaError extends Error {}
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const kind = (value: FormulaValue) => value === null ? "empty" : value instanceof Date ? "date" : typeof value;
const toNum = (value: FormulaValue): number => {
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  throw new FormulaError(`Expected a number, got ${kind(value)}`);
};
const toBool = (value: FormulaValue): boolean => {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  throw new FormulaError(`Expected true/false, got ${kind(value)}`);
};
export function formatDateValue(date: Date): string {
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", ...(date.getHours() || date.getMinutes() || date.getSeconds() ? { hour: "numeric", minute: "2-digit" } as const : {}) });
}
const toStr = (value: FormulaValue): string => value === null ? "" : value instanceof Date ? formatDateValue(value) : typeof value === "number" ? String(round6(value)) : String(value);
export function parseDateString(value: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const date = parts ? new Date(+parts[1], +parts[2] - 1, +parts[3]) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
const toDate = (value: FormulaValue): Date | null => {
  if (value === null || value === "") return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") { const date = parseDateString(value); if (date) return date; }
  throw new FormulaError(`Expected a date, got ${kind(value)}`);
};
const milliseconds: Record<string, number> = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 };
function unit(value: FormulaValue): string {
  let name = toStr(value).trim().toLowerCase();
  if (!name.endsWith("s")) name += "s";
  if (!(name in milliseconds) && !["months", "quarters", "years"].includes(name)) throw new FormulaError(`Unknown date unit "${name}"`);
  return name;
}
function dateFunction(name: string, args: FormulaValue[]): FormulaValue {
  const date = toDate(args[0] ?? null);
  if (!date) return name === "formatDate" ? "" : null;
  if (name === "year") return date.getFullYear();
  if (name === "month") return date.getMonth() + 1;
  if (name === "day") return date.getDate();
  if (name === "formatDate") {
    const pad = (n: number) => String(n).padStart(2, "0");
    const tokens: Record<string, string> = { YYYY: String(date.getFullYear()), MMM: date.toLocaleString(undefined, { month: "short" }), MM: pad(date.getMonth() + 1), DD: pad(date.getDate()), HH: pad(date.getHours()), mm: pad(date.getMinutes()), ss: pad(date.getSeconds()) };
    return (args[1] == null ? "YYYY-MM-DD" : toStr(args[1])).replace(/YYYY|MMM|MM|DD|HH|mm|ss/g, (token) => tokens[token]);
  }
  if (name === "dateBetween") {
    const other = toDate(args[1] ?? null);
    if (!other) return null;
    const u = unit(args[2] ?? null), months = (date.getFullYear() - other.getFullYear()) * 12 + date.getMonth() - other.getMonth();
    if (u === "years") return date.getFullYear() - other.getFullYear();
    if (u === "months") return months;
    if (u === "quarters") return Math.trunc(months / 3);
    return Math.trunc((+date - +other) / milliseconds[u]);
  }
  const count = toNum(args[1] ?? null) * (name === "dateSubtract" ? -1 : 1), u = unit(args[2] ?? null), result = new Date(date);
  if (u === "years") result.setFullYear(result.getFullYear() + count);
  else if (u === "months" || u === "quarters") result.setMonth(result.getMonth() + count * (u === "quarters" ? 3 : 1));
  else result.setTime(+result + count * milliseconds[u]);
  return result;
}
function evaluate(source: string, lookup: (name: string) => FormulaValue): FormulaValue {
  let offset = 0;
  const take = (pattern: RegExp) => {
    const spaces = /^\s*/.exec(source.slice(offset))![0].length;
    offset += spaces;
    const match = pattern.exec(source.slice(offset));
    if (!match) return null;
    offset += match[0].length;
    return match[0];
  };
  const call = (name: string, args: FormulaValue[]): FormulaValue => {
    const a = (i: number) => args[i] ?? null;
    switch (name) {
      case "prop": return lookup(toStr(a(0)));
      case "if": if (args.length < 2) throw new FormulaError("if() needs a condition and two branches"); return toBool(a(0)) ? a(1) : a(2);
      case "empty": return a(0) === null || a(0) === "" || a(0) === false;
      case "concat": return args.map(toStr).join("");
      case "length": return toStr(a(0)).length;
      case "lower": return toStr(a(0)).toLowerCase();
      case "upper": return toStr(a(0)).toUpperCase();
      case "contains": return toStr(a(0)).includes(toStr(a(1)));
      case "replace": return toStr(a(0)).split(toStr(a(1))).join(toStr(a(2)));
      case "slice": return toStr(a(0)).slice(toNum(a(1)), args.length > 2 ? toNum(a(2)) : undefined);
      case "format": return toStr(a(0));
      case "now": return new Date();
      case "dateAdd": case "dateSubtract": case "dateBetween": case "formatDate": case "year": case "month": case "day": return dateFunction(name, args);
      case "round": case "floor": case "ceil": case "abs": case "sqrt": return Math[name](toNum(a(0)));
      case "pow": return Math.pow(toNum(a(0)), toNum(a(1)));
      case "min": case "max": return Math[name](...args.map(toNum));
      default: throw new FormulaError(`Unknown function ${name}()`);
    }
  };
  const primary = (): FormulaValue => {
    if (take(/^\(/)) { const value = expr(); take(/^\)/); return value; }
    const quote = take(/^["']/);
    if (quote) {
      let value = "";
      while (offset < source.length && source[offset] !== quote) {
        if (source[offset] === "\\") offset++;
        if (offset < source.length) value += source[offset++];
      }
      if (source[offset] === quote) offset++;
      return value;
    }
    const number = take(/^[0-9]*\.?[0-9]+/);
    if (number !== null) return Number(number);
    const name = take(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (name === null) throw new FormulaError("Could not parse formula");
    if (name === "true" || name === "false") return name === "true";
    if (!take(/^\(/)) return lookup(name);
    const args: FormulaValue[] = [];
    if (!take(/^\)/)) {
      args.push(expr());
      while (take(/^,/)) args.push(expr());
      if (!take(/^\)/)) throw new FormulaError(`Missing ")" after ${name}(…`);
    }
    return call(name, args);
  };
  const unary = (): FormulaValue => { const op = take(/^[+-]/); return op ? (op === "-" ? -1 : 1) * toNum(unary()) : primary(); };
  const multiply = (): FormulaValue => {
    let value = unary(), op: string | null;
    while ((op = take(/^[*/%]/))) { const a = toNum(value), b = toNum(unary()); value = op === "*" ? a * b : op === "/" ? a / b : a % b; }
    return value;
  };
  const add = (): FormulaValue => {
    let value = multiply(), op: string | null;
    while ((op = take(/^[+-]/))) { const right = multiply(); value = op === "+" && (typeof value === "string" || typeof right === "string") ? toStr(value) + toStr(right) : op === "+" ? toNum(value) + toNum(right) : toNum(value) - toNum(right); }
    return value;
  };
  const compare = (): FormulaValue => {
    let value = add(), op: string | null;
    while ((op = take(/^(==|!=|>=|<=|>|<)/))) {
      const right = add();
      if (op === "==" || op === "!=") { const equal = value instanceof Date && right instanceof Date ? +value === +right : value === right; value = op === "==" ? equal : !equal; continue; }
      if (value === null || right === null) { value = false; continue; }
      if (kind(value) !== kind(right) || typeof value === "boolean") throw new FormulaError(`Cannot compare ${kind(value)} and ${kind(right)}`);
      const a = value instanceof Date ? +value : value, b = right instanceof Date ? +right : right;
      value = op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
    }
    return value;
  };
  const not = (): FormulaValue => take(/^(not\b|!(?!=))/) ? !toBool(not()) : compare();
  const and = (): FormulaValue => { let value = not(); while (take(/^(and\b|&&)/)) { const a = toBool(value), b = toBool(not()); value = a && b; } return value; };
  const expr = (): FormulaValue => { let value = and(); while (take(/^(or\b|\|\|)/)) { const a = toBool(value), b = toBool(and()); value = a || b; } return value; };
  const value = expr();
  take(/^\s*/);
  if (offset < source.length) throw new FormulaError(`Unexpected "${source.slice(offset, offset + 8)}"`);
  return value;
}

export const isEmpty = (value: unknown): boolean => value == null || value === "" || (Array.isArray(value) && value.length === 0);
export function formatNumber(value: number, format?: DbProperty["numberFormat"]): string {
  if (!Number.isFinite(value)) return "";
  if (format === "percent") return round6(value * 100).toLocaleString() + "%";
  return (format === "dollar" ? "$" : format === "euro" ? "€" : "") + round6(value).toLocaleString();
}
export function formatIdValue(prop: DbProperty, value: unknown): string {
  return isEmpty(value) ? "" : `${prop.idPrefix?.trim() ? prop.idPrefix.trim() + "-" : ""}${value}`;
}
export function isoDay(ms: number): string {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export function displayValue(value: unknown, prop: DbProperty, database?: Database, pages: Record<string, Page> = {}): string {
  if (isEmpty(value)) return "";
  if (value instanceof DateValue) return value.text;
  if (prop.type === "id") return formatIdValue(prop, value);
  if (prop.type === "select" || prop.type === "status") return prop.options?.find((o) => o.id === value)?.name ?? "";
  if (prop.type === "multiSelect") return (Array.isArray(value) ? value : []).map((id) => prop.options?.find((o) => o.id === id)?.name).filter(Boolean).join(", ");
  if (prop.type === "checkbox") return value === true ? "✓" : "";
  if (prop.type === "relation") return (Array.isArray(value) ? value : []).map((id) => pages[id]?.title || "Untitled").join(", ");
  if (prop.type === "createdTime" || prop.type === "lastEditedTime") return formatDateValue(new Date(Number(value)));
  if (typeof value === "number") return formatNumber(value, prop.numberFormat);
  return String(value);
}
export function computeCell(row: DbRow, prop: DbProperty, database: Database, pages: Record<string, Page>, ctx?: ComputeContext, seen = new Set<string>()): unknown {
  if (prop.id === "title") return row.cells.title || pages[row.pageId]?.title || "";
  if (prop.type === "createdTime") return pages[row.pageId]?.createdAt ?? null;
  if (prop.type === "lastEditedTime") return pages[row.pageId]?.updatedAt ?? null;
  if (prop.type === "createdBy" || prop.type === "lastEditedBy") {
    const id = row[prop.type];
    return [...(ctx?.members ?? []), ...(ctx?.agents ?? [])].find((a) => a.id === id)?.name ?? id ?? null;
  }
  if (prop.type === "agentStatus" || prop.type === "agentDelegate" || prop.type === "button") return null;
  if (prop.type !== "formula" && prop.type !== "rollup") return row.cells[prop.id] ?? null;
  const key = `${database.id}:${row.id}:${prop.id}`;
  if (seen.has(key)) return "⚠ Invalid formula";
  const nextSeen = new Set(seen).add(key);
  if (prop.type === "rollup") {
    const relation = database.properties.find((p) => p.id === prop.relationPropId);
    const related = relation?.relationDbId ? pages[relation.relationDbId]?.database : undefined;
    if (!relation || !related) return null;
    const ids = Array.isArray(row.cells[relation.id]) ? row.cells[relation.id] as string[] : [];
    const rows = ids.map((id) => related.rows.find((r) => r.pageId === id)).filter((r): r is DbRow => !!r);
    const target = related.properties.find((p) => p.id === prop.targetPropId);
    const values = rows.map((r) => target ? computeCell(r, target, related, pages, ctx, nextSeen) : pages[r.pageId]?.title ?? "");
    const nums = values.map((v) => typeof v === "number" ? v : parseFloat(String(v ?? ""))).filter((n) => !Number.isNaN(n));
    switch (prop.rollupFn) {
      case "countValues": return values.reduce<number>((count, v) => count + (Array.isArray(v) ? v.length : isEmpty(v) ? 0 : 1), 0);
      case "sum": return nums.reduce((a, b) => a + b, 0);
      case "average": return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      case "min": case "max": return nums.length ? Math[prop.rollupFn](...nums) : null;
      case "showOriginal": return values.map((v) => target ? displayValue(v, target, related, pages) : String(v ?? "")).filter(Boolean).join(", ");
      default: return rows.length;
    }
  }
  if (!prop.formula?.trim()) return null;
  try {
    const out = evaluate(prop.formula, (name) => {
      const target = database.properties.find((p) => p.name === name || p.id === name);
      if (!target) throw new FormulaError(`Unknown property "${name}"`);
      const value = computeCell(row, target, database, pages, ctx, nextSeen);
      if (target.type === "number") { const n = typeof value === "number" ? value : parseFloat(String(value ?? "")); return Number.isNaN(n) ? null : n; }
      if (target.type === "checkbox") return !!value;
      if (target.type === "date") return isEmpty(value) ? null : parseDateString(String(value));
      if (target.type === "createdTime" || target.type === "lastEditedTime") return value == null ? null : new Date(Number(value));
      if (target.type === "id") return isEmpty(value) ? null : formatIdValue(target, value);
      if (["select", "status", "multiSelect", "relation"].includes(target.type)) return displayValue(value, target, database, pages);
      if (value instanceof DateValue) return new Date(value.time);
      if (value == null || typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value as FormulaValue;
      return String(value);
    });
    return out instanceof Date ? new DateValue(+out, formatDateValue(out)) : typeof out === "number" ? Number.isFinite(out) ? round6(out) : null : out;
  } catch (error) { return `⚠ ${error instanceof FormulaError ? error.message : "Invalid formula"}`; }
}
export function sortValue(row: DbRow, prop: DbProperty, database: Database, pages: Record<string, Page>): string | number {
  const value = computeCell(row, prop, database, pages);
  return value instanceof DateValue ? value.time : typeof value === "number" ? value : displayValue(value, prop, database, pages);
}
export const viewSorts = (view: DbView) => view.sorts ?? [];
export function sortRows(rows: DbRow[], view: DbView, database: Database, pages: Record<string, Page>): DbRow[] {
  const rules = viewSorts(view).flatMap((rule) => { const prop = database.properties.find((p) => p.id === rule.propertyId); return prop ? [{ ...rule, prop }] : []; });
  if (!rules.length) return rows;
  return [...rows].sort((a, b) => {
    for (const rule of rules) {
      const av = sortValue(a, rule.prop, database, pages), bv = sortValue(b, rule.prop, database, pages);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      if (cmp) return rule.direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}
export function groupRows(rows: DbRow[], view: DbView, database: Database, pages: Record<string, Page>): { key: string | null; label: string; rows: DbRow[]; color?: string }[] {
  const prop = database.properties.find((p) => p.id === view.groupBy);
  if (!prop) return [{ key: null, label: "", rows }];
  if (prop.type === "select" || prop.type === "status") {
    const groups = (prop.options ?? []).map((o) => ({ key: o.id as string | null, label: o.name, color: o.color as string | undefined, rows: rows.filter((r) => r.cells[prop.id] === o.id) }));
    const empty = { key: null, label: `No ${prop.name}`, color: undefined, rows: rows.filter((r) => r.cells[prop.id] == null) };
    return view.type === "board" ? [empty, ...groups] : [...groups, empty];
  }
  const groups = new Map<string, DbRow[]>();
  for (const row of rows) { const key = String(computeCell(row, prop, database, pages) ?? ""); groups.set(key, [...(groups.get(key) ?? []), row]); }
  return [...groups].map(([key, rows]) => ({ key, label: key || "Empty", rows }));
}
export const AGG_LABELS: Record<AggregationFn, string> = {
  none: "None", count: "Count all", countValues: "Count values", countEmpty: "Count empty", countNotEmpty: "Count not empty", percentEmpty: "Percent empty", percentNotEmpty: "Percent filled",
  sum: "Sum", average: "Average", median: "Median", min: "Min", max: "Max", range: "Range", checked: "Checked", unchecked: "Unchecked", percentChecked: "Percent checked",
};
export function aggregationsFor(type: PropertyType): AggregationFn[] {
  const base: AggregationFn[] = ["none", "count", "countValues", "countEmpty", "countNotEmpty", "percentEmpty", "percentNotEmpty"];
  if (type === "checkbox") return ["none", "count", "checked", "unchecked", "percentChecked"];
  return ["number", "rollup", "formula"].includes(type) ? [...base, "sum", "average", "median", "min", "max", "range"] : base;
}
export function aggregate(fn: AggregationFn, rows: DbRow[], prop: DbProperty, database: Database, pages: Record<string, Page>): string {
  const values = rows.map((r) => computeCell(r, prop, database, pages)), filled = values.filter((v) => !isEmpty(v)).length;
  const pct = (n: number) => rows.length ? Math.round(n / rows.length * 100) + "%" : "0%";
  switch (fn) {
    case "none": return "";
    case "count": return String(rows.length);
    case "countValues": return String(values.reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : isEmpty(v) ? 0 : 1), 0));
    case "countEmpty": return String(rows.length - filled);
    case "countNotEmpty": return String(filled);
    case "percentEmpty": return pct(rows.length - filled);
    case "percentNotEmpty": return pct(filled);
    case "checked": return String(values.filter((v) => v === true).length);
    case "unchecked": return String(values.filter((v) => !v).length);
    case "percentChecked": return pct(values.filter((v) => v === true).length);
  }
  const nums = values.map((v) => typeof v === "number" ? v : parseFloat(String(v ?? ""))).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (!nums.length) return "";
  const sum = nums.reduce((a, b) => a + b, 0), middle = Math.floor(nums.length / 2);
  const value = fn === "sum" ? sum : fn === "average" ? sum / nums.length : fn === "min" ? nums[0] : fn === "max" ? nums.at(-1)! : fn === "range" ? nums.at(-1)! - nums[0] : nums.length % 2 ? nums[middle] : (nums[middle - 1] + nums[middle]) / 2;
  return formatNumber(value, prop.numberFormat);
}
