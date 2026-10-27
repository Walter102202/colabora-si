"use client";
import { useState } from "react";
import type { Database, Page } from "@/lib/types";
import type { DbOps } from "@/lib/dbOps";
import { createView } from "@/lib/factories";
import { filterRows } from "@/lib/dbFilter";
import { sortRows } from "@/lib/dbCompute";
import { VIEW_ICONS } from "@/components/database/dbShared";
import DatabaseRows from "@/components/database/DatabaseRows";
export default function ReadOnlyDatabaseView({ db, pages, onOpenRow }: { db: Database; pages: Record<string, Page>; onOpenRow?: (pageId: string) => void }) {
  const [active, setActive] = useState(0), [fallback] = useState(() => createView()), view = db.views[active] ?? db.views[0] ?? fallback;
  const rows = sortRows(filterRows(db.rows, view, db, pages), view, db, pages), ignore = () => {};
  const ops: DbOps = {
    pageId: Object.values(pages).find((p) => p.database?.id === db.id)?.id ?? "", database: db, readOnly: true, locked: true,
    addRow: () => "", updateCell: ignore, deleteRow: ignore, addProperty: ignore, updateProperty: ignore, deleteProperty: ignore,
    addView: ignore, updateView: ignore, deleteView: ignore, setLocked: ignore, addRowFromTemplate: () => "", saveRowAsTemplate: ignore, deleteRowTemplate: ignore, runButton: ignore,
    openRow: (id) => { const pageId = db.rows.find((r) => r.id === id)?.pageId ?? id; if (pages[pageId]) onOpenRow?.(pageId); },
  };
  return <div className="database-view">{db.views.length > 1 && <div className="database-tabs">{db.views.map((v, i) => <button key={v.id} aria-pressed={v.id === view.id} onClick={() => setActive(i)}>{VIEW_ICONS[v.type]} {v.name}</button>)}</div>}<p className="py-2 text-xs text-text-tertiary">{rows.length} {rows.length === 1 ? "row" : "rows"}</p><DatabaseRows ops={ops} database={db} view={view} rows={rows} pages={pages} canOpenRow={(row) => !!onOpenRow && !!pages[row.pageId]} /></div>;
}
