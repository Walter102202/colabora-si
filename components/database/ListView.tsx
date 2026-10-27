"use client";
import { useState } from "react";
import { CellPreview, flattenTree, visibleProperties, type ViewProps } from "@/components/database/dbShared";
import { rowColorClass } from "@/lib/dbFilter";
export default function ListView({ ops, database, view, rows, pages, canOpenRow }: ViewProps) {
  const [collapsed, setCollapsed] = useState(new Set<string>()), extras = visibleProperties(database, view).filter((p) => p.id !== "title");
  const list = ops.readOnly ? rows.map((row) => ({ row, depth: 0, hasChildren: false })) : flattenTree(rows, collapsed);
  return <div>{!rows.length && <p className="empty-state">{ops.readOnly ? "No rows." : "No items yet."}</p>}{list.map(({ row, depth, hasChildren }) => {
    const openable = canOpenRow?.(row) ?? true;
    return <div key={row.id} className={`database-list-row ${rowColorClass(row, view, database, pages)}`} role={openable ? "button" : undefined} tabIndex={openable ? 0 : undefined} style={{ paddingLeft: 4 + depth * 18 }} onClick={() => { if (openable) ops.openRow(row.id); }} onKeyDown={(e) => { if (openable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); ops.openRow(row.id); } }}>
      {hasChildren ? <button aria-label={collapsed.has(row.id) ? "Expand sub-items" : "Collapse sub-items"} onClick={(e) => { e.stopPropagation(); const next = new Set(collapsed); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); setCollapsed(next); }}>{collapsed.has(row.id) ? "▸" : "▾"}</button> : depth ? <span>↳</span> : null}<span>{pages[row.pageId]?.icon ?? "📄"}</span><strong className="min-w-0 flex-1 truncate text-sm font-medium">{String(row.cells.title || pages[row.pageId]?.title || "Untitled")}</strong><div className="flex items-center gap-3">{extras.map((property) => <CellPreview key={property.id} row={row} property={property} database={database} pages={pages} />)}</div>
    </div>;
  })}{!ops.readOnly && <button className="new-row" onClick={() => ops.addRow()}>+ New</button>}</div>;
}
