"use client";
import { useRef, useState } from "react";
import type { ViewProps } from "@/components/database/dbShared";
import { computeCell } from "@/lib/dbCompute";
import { rowColorClass } from "@/lib/dbFilter";
const DAY = 86400000, DAY_W = 34, LABEL_W = 180;
function parseDay(value: unknown): number | null {
  const iso = String(value ?? "").slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const time = Date.parse(iso + "T00:00:00Z"); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === iso ? time / DAY : null;
}
type Drag = { id: string; x: number; start: number; end: number; mode: "move" | "start" | "end"; ds: number; de: number };
export default function TimelineView({ ops, database, view, rows, pages, canOpenRow }: ViewProps) {
  const [drag, setDrag] = useState<Drag | null>(null), current = useRef<Drag | null>(null), ignoreClick = useRef(false);
  const props = database.properties.filter((p) => ["date", "createdTime", "lastEditedTime"].includes(p.type)), startProp = props.find((p) => p.id === view.dateProp) ?? props[0], endProp = props.find((p) => p.id === view.endDateProp);
  if (!startProp) return <p className="empty-block">{ops.readOnly ? "This timeline view has no date property." : "Add a Date property to use the timeline view."}</p>;
  const bars = rows.flatMap((row) => { const start = parseDay(computeCell(row, startProp, database, pages)); if (start === null) return []; const end = endProp ? parseDay(computeCell(row, endProp, database, pages)) ?? start : start; return [{ row, start, end: Math.max(start, end) }]; });
  const today = Math.floor(Date.now() / DAY), now = new Date(), fallbackStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / DAY, fallbackEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0) / DAY;
  const min = Math.min(today, ...(bars.length ? bars.map((b) => b.start) : [fallbackStart])) - 2, max = Math.max(today, ...(bars.length ? bars.map((b) => b.end) : [fallbackEnd])) + 4, days = max - min + 1;
  const months: { label: string; span: number }[] = [];
  for (let i = 0; i < days; i++) { const label = new Date((min + i) * DAY).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "numeric" }); if (months.at(-1)?.label === label) months[months.length - 1].span++; else months.push({ label, span: 1 }); }
  const endDrag = () => {
    const d = current.current; if (!d) return;
    if (d.ds) ops.updateCell(d.id, startProp.id, new Date((d.start + d.ds) * DAY).toISOString().slice(0, 10));
    const row = rows.find((r) => r.id === d.id);
    if (d.de && endProp?.type === "date" && (d.mode === "end" || row?.cells[endProp.id])) ops.updateCell(d.id, endProp.id, new Date((d.end + d.de) * DAY).toISOString().slice(0, 10));
    ignoreClick.current = !!(d.ds || d.de); current.current = null; setDrag(null); setTimeout(() => { ignoreClick.current = false; }, 0);
  };
  return <div><div className="timeline-scroll"><div className="timeline" style={{ width: LABEL_W + days * DAY_W }}><div className="timeline-months"><span style={{ width: LABEL_W }}>{bars.length} {bars.length === 1 ? "item" : "items"}</span>{months.map((m, i) => <span key={i} style={{ width: m.span * DAY_W }}>{m.label}</span>)}</div><div className="timeline-days" style={{ paddingLeft: LABEL_W }}>{Array.from({ length: days }, (_, i) => <span key={i} style={{ width: DAY_W }} className={min + i === today ? "text-accent font-bold" : ""}>{new Date((min + i) * DAY).getUTCDate()}</span>)}</div><span className="timeline-today" style={{ left: LABEL_W + (today - min) * DAY_W + DAY_W / 2 }} />
    {bars.map(({ row, start, end }) => {
      const active = drag?.id === row.id ? drag : null, ds = active?.ds ?? 0, de = active?.de ?? 0, span = end + de - start - ds + 1, title = String(row.cells.title || pages[row.pageId]?.title || "Untitled"), editable = !ops.readOnly && startProp.type === "date";
      return <div key={row.id} className={`timeline-row ${rowColorClass(row, view, database, pages)}`}><button className="timeline-label" style={{ width: LABEL_W }} disabled={canOpenRow ? !canOpenRow(row) : false} onClick={() => ops.openRow(row.id)}>{pages[row.pageId]?.icon ?? "📄"} {title}</button><div className="timeline-track" style={{ width: days * DAY_W }}><div className={`timeline-bar ${active ? "dragging" : ""}`} title={title} style={{ left: (start + ds - min) * DAY_W + 2, width: Math.max(span * DAY_W - 4, 16) }} onClick={() => { if (!ignoreClick.current && (canOpenRow?.(row) ?? true)) ops.openRow(row.id); }} onPointerDown={(e) => {
        if (!editable) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); const mode = (e.target as HTMLElement).dataset.mode as Drag["mode"] | undefined;
        current.current = { id: row.id, x: e.clientX, start, end, mode: mode ?? "move", ds: 0, de: 0 }; setDrag(current.current);
      }} onPointerMove={(e) => { const d = current.current; if (!d || d.id !== row.id) return; const delta = Math.round((e.clientX - d.x) / DAY_W), span = d.end - d.start; const next = { ...d, ds: d.mode === "end" ? 0 : d.mode === "start" ? Math.min(delta, span) : delta, de: d.mode === "start" ? 0 : d.mode === "end" ? Math.max(delta, -span) : delta }; current.current = next; setDrag(next); }} onPointerUp={endDrag} onPointerCancel={endDrag}>{editable && <span data-mode="start" className="timeline-handle left-0" title="Drag to change start date" />}{span > 1 && title}{editable && endProp?.type === "date" && <span data-mode="end" className="timeline-handle right-0" title="Drag to change end date" />}</div></div></div>;
    })}{!bars.length && <p className="p-4 text-sm text-text-tertiary">{ops.readOnly ? "No rows with a date." : "No rows with a date yet."}</p>}</div></div>{!ops.readOnly && <div className="flex gap-3 p-2 text-xs"><label>Start <select disabled={ops.locked} value={startProp.id} onChange={(e) => ops.updateView(view.id, { dateProp: e.target.value })}>{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>End <select disabled={ops.locked} value={endProp?.id ?? ""} onChange={(e) => ops.updateView(view.id, { endDateProp: e.target.value || undefined })}><option value="">None</option>{props.filter((p) => p.id !== startProp.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>}</div>;
}
