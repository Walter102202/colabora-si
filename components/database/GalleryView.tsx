import { CellPreview } from "@/components/database/dbShared";
import { subItemCounts, visibleProperties, type ViewProps } from "@/lib/dbView";
import { rowColorClass } from "@/lib/dbFilter";
import { coverBackground } from "@/lib/cover";
export default function GalleryView({ ops, database, queryDatabase = database, view, rows, pages, canOpenRow }: ViewProps) {
  const extras = visibleProperties(database, view).filter((p) => p.id !== "title"), counts = subItemCounts(database.rows);
  return <div className="database-gallery">{rows.map((row) => {
    const page = pages[row.pageId], cover = coverBackground(page?.cover), openable = canOpenRow?.(row) ?? true;
    return <div key={row.id} className={`gallery-card ${rowColorClass(row, view, queryDatabase, pages)}`}><button className="block w-full text-left" disabled={!openable} onClick={() => ops.openRow(row.id)}><span className="gallery-cover block" style={{ backgroundImage: cover }}>{!cover && (page?.icon ?? "📄")}</span><strong className="block truncate px-2.5 pt-2 text-sm font-medium">{String(row.cells.title || page?.title || "Untitled")}</strong></button><div className="px-2.5 py-2"><div className="mt-2 flex flex-wrap gap-1.5">{!ops.readOnly && counts[row.id] && <span className="text-xs text-text-tertiary">{counts[row.id]} sub-items</span>}{extras.map((property) => <CellPreview key={property.id} row={row} property={property} database={database} pages={pages} />)}</div></div></div>;
  })}{!ops.readOnly && <button className="gallery-new" onClick={() => ops.addRow()}>+ New</button>}</div>;
}
