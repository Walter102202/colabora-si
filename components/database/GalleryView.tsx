"use client";
import { CellPreview, subItemCounts, visibleProperties, type ViewProps } from "@/components/database/dbShared";
import { rowColorClass } from "@/lib/dbFilter";
import { coverBackground } from "@/lib/cover";
export default function GalleryView({ ops, database, view, rows, pages, canOpenRow }: ViewProps) {
  const extras = visibleProperties(database, view).filter((p) => p.id !== "title"), counts = subItemCounts(database.rows);
  return <div className="database-gallery">{rows.map((row) => {
    const page = pages[row.pageId], cover = coverBackground(page?.cover), openable = canOpenRow?.(row) ?? true;
    return <div key={row.id} className={`gallery-card ${rowColorClass(row, view, database, pages)}`} role={openable ? "button" : undefined} tabIndex={openable ? 0 : undefined} onClick={() => { if (openable) ops.openRow(row.id); }} onKeyDown={(e) => { if (openable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); ops.openRow(row.id); } }}><div className="gallery-cover" style={{ backgroundImage: cover }}>{!cover && (page?.icon ?? "📄")}</div><div className="px-2.5 py-2"><strong className="block truncate text-sm font-medium">{String(row.cells.title || page?.title || "Untitled")}</strong><div className="mt-2 flex flex-wrap gap-1.5">{!ops.readOnly && counts[row.id] && <span className="text-xs text-text-tertiary">{counts[row.id]} sub-items</span>}{extras.map((property) => <CellPreview key={property.id} row={row} property={property} database={database} pages={pages} />)}</div></div></div>;
  })}{!ops.readOnly && <button className="gallery-new" onClick={() => ops.addRow()}>+ New</button>}</div>;
}
