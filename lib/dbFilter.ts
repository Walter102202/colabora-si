import type { Database, DbRow, DbView, FilterCondition, FilterOperator, Page, PropertyType } from "@/lib/types";
import { computeCell, DateValue, formatIdValue, isEmpty, isoDay } from "@/lib/dbCompute";
const toIsoDate = (value: unknown) => typeof value === "number" ? isoDay(value) : String(value ?? "").slice(0, 10);
export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: "is", isNot: "is not", contains: "contains", notContains: "does not contain",
  isEmpty: "is empty", isNotEmpty: "is not empty", gt: "greater than", lt: "less than",
  checked: "is checked", unchecked: "is unchecked",
};
export const NO_VALUE_OPS = new Set<FilterOperator>(["isEmpty", "isNotEmpty", "checked", "unchecked"]);

export function operatorsFor(type: PropertyType): FilterOperator[] {
  switch (type) {
    case "agentStatus": return ["is", "isNot", "isEmpty"];
    case "number": case "rollup": case "formula":
      return ["is", "isNot", "gt", "lt", "isEmpty", "isNotEmpty"];
    case "select": case "status":
      return ["is", "isNot", "isEmpty", "isNotEmpty"];
    case "multiSelect":
      return ["contains", "notContains", "isEmpty", "isNotEmpty"];
    case "checkbox":
      return ["checked", "unchecked"];
    case "date": case "createdTime": case "lastEditedTime":
      return ["is", "isNot", "gt", "lt", "isEmpty", "isNotEmpty"];
    case "relation": case "files":
      return ["isEmpty", "isNotEmpty"];
    case "id":
      return ["is", "isNot", "contains", "notContains", "gt", "lt"];
    default: // text, url, email, phone, person, title
      return ["is", "isNot", "contains", "notContains", "isEmpty", "isNotEmpty"];
  }
}
export const defaultOperator = (type: PropertyType) => operatorsFor(type)[0];

export function matchCondition(row: DbRow, cond: FilterCondition, db: Database, pages: Record<string, Page>): boolean {
  const prop = db.properties.find((p) => p.id === cond.propertyId);
  if (!prop) return true;                                   // propiedad borrada: el filtro no oculta nada
  const v = computeCell(row, prop, db, pages);

  switch (cond.operator) {
    case "isEmpty": return isEmpty(v);
    case "isNotEmpty": return !isEmpty(v);
    case "checked": return !!v;
    case "unchecked": return !v;
  }
  const target = cond.value ?? "";

  // Fórmula con resultado fecha: comparar por día ISO del instante.
  if (v instanceof DateValue) {
    const t = /^\d{4}-\d{2}-\d{2}/.test(target) ? target.slice(0, 10)
            : isNaN(Date.parse(target)) ? null : isoDay(Date.parse(target));
    if (t) {
      const dv = isoDay(v.time);
      switch (cond.operator) {
        case "is": return dv === t;  case "isNot": return dv !== t;
        case "gt": return dv > t;    case "lt": return dv < t;
      }
    }
    // objetivo no-fecha (p. ej. contains "Aug"): cae al texto
  }

  if (prop.type === "number" || prop.type === "rollup" || prop.type === "formula") {
    const numericTarget = target !== "" && !isNaN(Number(target));
    if (!numericTarget) {
      if (prop.type === "number") return true;             // objetivo vacío o no numérico: filtro inactivo
    } else {
      const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
      const t = parseFloat(target);
      if (isNaN(n)) return cond.operator === "isNot";      // celda vacía/no numérica ≠ objetivo
      switch (cond.operator) {
        case "is": return n === t;  case "isNot": return n !== t;
        case "gt": return n > t;    case "lt": return n < t;
      }
    }
  }

  if (prop.type === "id") {
    if (target === "") return true;
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    if (cond.operator === "gt" || cond.operator === "lt") {
      const t = parseFloat(target.replace(/^[^0-9]*/, ""));  // "TASK-3" → 3
      if (isNaN(t)) return true;                             // sin dígitos: inactivo
      if (isNaN(n)) return false;
      return cond.operator === "gt" ? n > t : n < t;
    }
    const sv = formatIdValue(prop, v).toLowerCase();
    const st = target.toLowerCase();
    switch (cond.operator) {
      case "is": return sv === st || String(v ?? "") === st;
      case "isNot": return sv !== st && String(v ?? "") !== st;
      case "contains": return sv.includes(st);
      case "notContains": return !sv.includes(st);
    }
  }

  if (prop.type === "multiSelect") {
    const arr = Array.isArray(v) ? (v as string[]) : [];
    switch (cond.operator) {
      case "contains": return arr.includes(target);          // target = id de opción
      case "notContains": return !arr.includes(target);
    }
  }

  if (prop.type === "date" || prop.type === "createdTime" || prop.type === "lastEditedTime") {
    if (target === "") return true;
    const dv = toIsoDate(v);
    switch (cond.operator) {
      case "is": return dv === target;  case "isNot": return dv !== target;
      case "gt": return dv > target;    case "lt": return dv < target;    // comparación de strings ISO
    }
  }

  if (target === "") return true;                            // objetivo vacío: filtro inactivo
  const exact = prop.type === "select" || prop.type === "status"; // ids de opción, sensible a mayúsculas
  const sv = exact ? String(v ?? "") : String(v ?? "").toLowerCase();
  const st = exact ? target : target.toLowerCase();
  switch (cond.operator) {
    case "is": return sv === st;             case "isNot": return sv !== st;
    case "contains": return sv.includes(st); case "notContains": return !sv.includes(st);
    case "gt": return sv > st;               case "lt": return sv < st;   // solo fórmula/rollup con texto
  }
  return true;
}

export function filterRows(rows: DbRow[], view: DbView, database: Database, pages: Record<string, Page>): DbRow[] {
  const filters = view.filters ?? [];
  if (!filters.length) return rows;
  return rows.filter((row) => view.filterConjunction === "or" ? filters.some((c) => matchCondition(row, c, database, pages)) : filters.every((c) => matchCondition(row, c, database, pages)));
}
export const applyFilters = filterRows;
export function rowColorKey(row: DbRow, view: DbView, database: Database, pages: Record<string, Page>): string | null {
  for (const rule of view.colorRules ?? []) {
    if (!NO_VALUE_OPS.has(rule.operator) && !rule.value) continue;
    if (matchCondition(row, rule, database, pages)) return rule.color;
  }
  return null;
}
export function rowColorClass(row: DbRow, view: DbView, database: Database, pages: Record<string, Page>): string {
  const color = rowColorKey(row, view, database, pages);
  return color ? `bc-${color}` : "";
}