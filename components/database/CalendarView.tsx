"use client";
import { useState } from "react";
import type { ViewProps } from "@/components/database/dbShared";
import { rowColorClass } from "@/lib/dbFilter";
export default function CalendarView({ ops, database, queryDatabase = database, view, rows, pages, canOpenRow }: ViewProps) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { year: d.getUTCFullYear(), month: d.getUTCMonth() }; });
  const prop = database.properties.find((p) => p.id === view.dateProp) ?? database.properties.find((p) => p.type === "date");
  if (!prop) return <p className="empty-block">{ops.readOnly ? "This calendar view has no date property." : "Add a Date property to use the calendar view."}</p>;
  const first = new Date(Date.UTC(cursor.year, cursor.month, 1)), start = first.getUTCDay(), count = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate(), slots = Math.ceil((start + count) / 7) * 7, today = new Date().toISOString().slice(0, 10);
  const shift = (delta: number) => { const d = new Date(Date.UTC(cursor.year, cursor.month + delta, 1)); setCursor({ year: d.getUTCFullYear(), month: d.getUTCMonth() }); };
  return <div><div className="mb-3 flex items-center gap-2"><strong className="mr-auto text-sm">{first.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" })}</strong><button className="icon-button" aria-label="Previous month" onClick={() => shift(-1)}>‹</button><button className="action-button" onClick={() => { const d = new Date(); setCursor({ year: d.getUTCFullYear(), month: d.getUTCMonth() }); }}>Today</button><button className="icon-button" aria-label="Next month" onClick={() => shift(1)}>›</button></div><div className="database-calendar-grid">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => <div key={name} className="calendar-weekday">{name}</div>)}{Array.from({ length: slots }, (_, index) => {
    const day = index - start + 1; if (day < 1 || day > count) return <div key={index} className="calendar-day empty" />;
    const iso = `${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`, matches = rows.filter((r) => String(r.cells[prop.id] ?? "").slice(0, 10) === iso);
    return <div key={index} className={`calendar-day ${[0, 6].includes(index % 7) ? "weekend" : ""}`}><div className="mb-1 flex items-center justify-between"><span className={iso === today ? "calendar-today" : ""}>{day}</span>{!ops.readOnly && <button className="hover-actions" aria-label={`New page on ${iso}`} title="New page on this day" onClick={() => { const id = ops.addRow(); if (id) ops.updateCell(id, prop.id, iso); }}>+</button>}</div>{matches.map((row) => <button key={row.id} disabled={canOpenRow ? !canOpenRow(row) : false} className={`calendar-chip ${rowColorClass(row, view, queryDatabase, pages)}`} title={String(row.cells.title || pages[row.pageId]?.title || "Untitled")} onClick={() => ops.openRow(row.id)}>{pages[row.pageId]?.icon} {String(row.cells.title || pages[row.pageId]?.title || "Untitled")}</button>)}</div>;
  })}</div></div>;
}

