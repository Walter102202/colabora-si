import { useState } from "react";
import { CellPreview } from "@/components/database/dbShared";
import { visibleProperties, type ViewProps } from "@/lib/dbView";
import { groupRows } from "@/lib/dbCompute";
import { rowColorClass } from "@/lib/dbFilter";
export default function BoardView({ ops, database, queryDatabase = database, view, rows, pages, canOpenRow }: ViewProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const prop = database.properties.find((p) => p.id === view.groupBy);
  if (!prop || !["select", "status", "agentStatus"].includes(prop.type)) return <div className="empty-state">{ops.readOnly ? "This board view has no group-by property." : "Board view needs a Select or Status property to group by."}</div>;
  const groups = groupRows(rows, view, queryDatabase, pages).map((group) => {
    const order = view.boardOrder?.[group.key ?? "__none"] ?? [];
    return { ...group, rows: [...group.rows].sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : order.length) - (order.includes(b.id) ? order.indexOf(b.id) : order.length)) };
  });
  const extras = visibleProperties(database, view).filter((p) => p.id !== "title" && p.id !== prop.id);
  const add = (key: string | null) => { const rowId = ops.addRow(); if (rowId && key && prop.type !== "agentStatus") ops.updateCell(rowId, prop.id, key); };
  const drop = (key: string | null, index: number) => {
    if (!dragging || ops.readOnly || prop.type === "agentStatus") return;
    const row = database.rows.find((r) => r.id === dragging);
    if (!row) return;
    const destination = key ?? "__none", boardOrder = { ...view.boardOrder };
    for (const group of groups) {
      const groupKey = group.key ?? "__none", visible = group.rows.map((r) => r.id).filter((id) => id !== dragging), saved = (boardOrder[groupKey] ?? group.rows.map((r) => r.id)).filter((id) => id !== dragging);
      const visibleSet = new Set(visible); let n = 0;
      boardOrder[groupKey] = saved.map((id) => visibleSet.has(id) ? visible[n++] : id);
      boardOrder[groupKey].push(...visible.slice(n));
    }
    const group = groups.find((g) => (g.key ?? "__none") === destination)!;
    const oldIndex = group.rows.findIndex((r) => r.id === dragging), visible = group.rows.filter((r) => r.id !== dragging);
    const at = oldIndex >= 0 && oldIndex < index ? index - 1 : index, saved = boardOrder[destination] ?? [];
    const position = !visible.length ? saved.length : at >= visible.length ? saved.indexOf(visible.at(-1)!.id) + 1 : saved.indexOf(visible[at].id);
    saved.splice(Math.max(0, position), 0, dragging); boardOrder[destination] = saved;
    if ((row.cells[prop.id] ?? null) !== key) ops.updateCell(dragging, prop.id, key);
    ops.updateView(view.id, { boardOrder }); setDragging(null);
  };
  return <div className="database-board">{groups.map((group) => <section role="presentation" aria-label={group.label || `No ${prop.name}`} className="board-column" key={group.key ?? "__none"} onDragOver={(event) => { if (dragging) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); drop(group.key, group.rows.length); }}><header><span className={group.color ? `tc-${group.color}` : ""}>{group.label || `No ${prop.name}`}</span><span className="text-text-tertiary">{group.rows.length}</span>{!ops.readOnly && <button aria-label="New card" onClick={() => add(group.key)}>+</button>}</header>
    {group.rows.map((row, index) => <div key={row.id} className={`board-card ${rowColorClass(row, view, queryDatabase, pages)} ${dragging === row.id ? "opacity-50" : ""}`} role="presentation" draggable={!ops.readOnly && prop.type !== "agentStatus"} onDragStart={(event) => { setDragging(row.id); event.dataTransfer.setData("text/row-id", row.id); }} onDragEnd={() => setDragging(null)} onDragOver={(event) => { if (dragging) { event.preventDefault(); event.stopPropagation(); } }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); drop(group.key, index + (event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2 ? 1 : 0)); }}><button className="w-full text-left text-sm font-medium" disabled={!(canOpenRow?.(row) ?? true)} onClick={() => ops.openRow(row.id)}>{pages[row.pageId]?.icon ?? "📄"} {String(row.cells.title || pages[row.pageId]?.title || "Untitled")}</button><div className="mt-2 flex flex-wrap gap-2">{!ops.readOnly && database.rows.some((r) => r.parentRowId === row.id) && <span className="text-xs text-text-tertiary">{database.rows.filter((r) => r.parentRowId === row.id).length} sub-items</span>}{extras.map((property) => <CellPreview key={property.id} row={row} property={property} database={database} pages={pages} />)}</div></div>)}
    {!ops.readOnly && <button className="new-row" onClick={() => add(group.key)}>+ New</button>}
  </section>)}</div>;
}
