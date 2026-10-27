"use client";
import type { Database, DbProperty, DbRow, DbView, Page, PropertyType } from "@/lib/types";
import { computeCell, displayValue } from "@/lib/dbCompute";
import type { DbOps } from "@/lib/dbOps";
export interface ViewProps { ops: DbOps; database: Database; view: DbView; rows: DbRow[]; pages: Record<string, Page> }
export const TYPE_LABELS: Record<PropertyType, string> = {
  text: "Text", number: "Number", select: "Select", multiSelect: "Multi-select", status: "Status", date: "Date", checkbox: "Checkbox", url: "URL", email: "Email", phone: "Phone", person: "Person", files: "Files & media", createdTime: "Created time", lastEditedTime: "Last edited time", relation: "Relation", rollup: "Rollup", formula: "Formula", id: "ID", createdBy: "Created by", lastEditedBy: "Last edited by", agentStatus: "Agent status", agentDelegate: "Agent delegate", button: "Button",
};
export const TYPE_ICONS: Record<PropertyType, string> = {
  text: "T", number: "#", select: "▾", multiSelect: "▤", status: "◉", date: "▦", checkbox: "☑", url: "↗", email: "@", phone: "☎", person: "♙", files: "⊞", createdTime: "◷", lastEditedTime: "◷", relation: "↔", rollup: "Σ", formula: "∑", id: "#", createdBy: "♙", lastEditedBy: "♙", agentStatus: "◉", agentDelegate: "🤖", button: "▶",
};
export const VIEW_ICONS = { table: "▦", board: "▥", list: "☰", gallery: "▧", calendar: "▦", timeline: "▬" };
export const visibleProperties = (database: Database, view: DbView) => {
  const order = view.propOrder ?? [];
  return [...database.properties].sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : order.length) - (order.includes(b.id) ? order.indexOf(b.id) : order.length)).filter((p) => p.id === "title" || !view.hiddenProps?.includes(p.id));
};
export function rowSearchText(row: DbRow, database: Database, pages: Record<string, Page>): string {
  return database.properties.map((p) => displayValue(computeCell(row, p, database, pages), p, database, pages)).join(" ").toLowerCase();
}
export const isAutoProperty = (property: DbProperty, database: Database): boolean => ["agentStatus", "agentDelegate", "createdTime", "lastEditedTime", "createdBy", "lastEditedBy", "id", "formula", "rollup"].includes(property.type) || (database.properties.some((p) => p.type === "agentStatus") && ["Lead", "Done when", "Output", "Cost", "Run"].includes(property.name));
export function CellPreview({ row, property, database, pages }: { row: DbRow; property: DbProperty; database: Database; pages: Record<string, Page> }) {
  const text = displayValue(computeCell(row, property, database, pages), property, database, pages);
  return text ? <span className="text-xs text-text-secondary">{text}</span> : null;
}

export function flattenTree(rows: DbRow[], collapsed: Set<string>): { row: DbRow; depth: number; hasChildren: boolean }[] {
  const ids = new Set(rows.map((r) => r.id)), children = new Map<string, DbRow[]>(), roots: DbRow[] = [];
  for (const row of rows) {
    if (row.parentRowId && row.parentRowId !== row.id && ids.has(row.parentRowId)) children.set(row.parentRowId, [...(children.get(row.parentRowId) ?? []), row]);
    else roots.push(row);
  }
  const result: { row: DbRow; depth: number; hasChildren: boolean }[] = [], seen = new Set<string>();
  const visit = (row: DbRow, depth: number, hidden = false) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    if (!hidden) result.push({ row, depth, hasChildren: !!children.get(row.id)?.length });
    for (const child of children.get(row.id) ?? []) visit(child, depth + 1, hidden || collapsed.has(row.id));
  };
  for (const root of roots) visit(root, 0);
  for (const row of rows) if (!seen.has(row.id)) visit(row, 0);
  return result;
}
export function subItemCounts(rows: DbRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) if (row.parentRowId) counts[row.parentRowId] = (counts[row.parentRowId] ?? 0) + 1;
  return counts;
}
