"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentPropertyCell } from "@/components/agents/AgentPropertyCell";
import DatePickerCalendar, { formatIsoDate } from "@/components/DatePickerCalendar";
import { computeCell, displayValue } from "@/lib/dbCompute";
import { newId } from "@/lib/factories";
import { isAutoProperty } from "@/components/database/dbShared";
import type { Database, DbProperty, DbRow, Page } from "@/lib/types";
import type { DbOps } from "@/lib/dbOps";
function CellInput({ value, onSave, placeholder = "", type = "text", readOnly = false, label }: { value: string; onSave: (value: string) => void; placeholder?: string; type?: string; readOnly?: boolean; label: string }) {
  const element = useRef<HTMLInputElement>(null);
  useEffect(() => { if (element.current && document.activeElement !== element.current) element.current.value = value; }, [value]);
  return <input ref={element} className="cell-input" type={type} defaultValue={value} aria-label={label} readOnly={readOnly} placeholder={placeholder} onBlur={(event) => { if (!readOnly && event.target.value !== value) onSave(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = value; event.currentTarget.blur(); } }} />;
}
export default function Cell({ ops, database, row, property, pages }: { ops: DbOps; database: Database; row: DbRow; property: DbProperty; pages: Record<string, Page> }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null), [query, setQuery] = useState("");
  const value = computeCell(row, property, database, pages), text = displayValue(value, property, database, pages);
  const set = (value: unknown) => ops.updateCell(row.id, property.id, value);
  const close = () => { setAnchor(null); setQuery(""); };
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape") setAnchor(null); }; document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key); }, []);
  if (property.type === "agentStatus" || property.type === "agentDelegate") return <AgentPropertyCell pageId={row.pageId} propertyId={property.id} kind={property.type} />;
  if (property.type === "button") return <button className="cell-button" disabled={ops.readOnly} onClick={() => { for (const action of property.buttonActions ?? []) ops.runButton(row.id, action); }}>{property.buttonLabel || "Run"}</button>;
  if (isAutoProperty(property, database)) return <span className="cell-readonly" title="Automatically updated">{text || "—"}</span>;
  if (property.type === "checkbox") return <input className="m-1 accent-accent" aria-label={property.name} type="checkbox" checked={!!value} disabled={ops.readOnly} onChange={(event) => set(event.target.checked)} />;
  if (["select", "status", "multiSelect", "date"].includes(property.type)) {
    const select = property.type !== "date", options = (property.options ?? []).filter((o) => o.name.toLowerCase().includes(query.toLowerCase()));
    return <><button className="cell-button" disabled={ops.readOnly} onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}>{property.type === "date" && value ? formatIsoDate(String(value).slice(0, 10)) : text || <span className="text-text-tertiary">Empty</span>}</button>{anchor && createPortal(<><button className="cell-backdrop" aria-label="Close cell editor" onClick={close} /><div className="menu-panel cell-popover" style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 256)), top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - 320)) }}>
      {select ? <><input autoFocus className="cell-input" placeholder="Search or create an option…" aria-label="Search options" value={query} onChange={(event) => setQuery(event.target.value)} />{options.map((option) => <button key={option.id} onClick={() => { if (property.type === "multiSelect") { const values = Array.isArray(value) ? value : []; set(values.includes(option.id) ? values.filter((v) => v !== option.id) : [...values, option.id]); } else { set(option.id); close(); } }}><span className={`tc-${option.color}`}>●</span>{option.name}</button>)}{query.trim() && !ops.locked && !options.some((o) => o.name === query.trim()) && <button onClick={() => { const option = { id: newId(), name: query.trim(), color: "gray" as const }; ops.updateProperty(property.id, { options: [...(property.options ?? []), option] }); set(property.type === "multiSelect" ? [...(Array.isArray(value) ? value : []), option.id] : option.id); close(); }}>Create “{query.trim()}”</button>}</> : <DatePickerCalendar value={value ? String(value).slice(0, 10) : null} onSelect={(iso) => { set(iso); close(); }} />}
      <button onClick={() => { set(null); close(); }}>{select ? "Clear" : "Clear date"}</button>
    </div></>, document.body)}</>;
  }
  return <div className="flex min-w-0 items-center"><CellInput label={property.name} value={value == null ? "" : String(value)} readOnly={ops.readOnly} type={property.type === "number" ? "number" : property.type === "email" ? "email" : property.type === "phone" ? "tel" : "text"} placeholder={property.id === "title" ? "Untitled" : property.type === "url" ? "https://" : property.type === "person" ? "Person" : ""} onSave={(text) => set(property.type === "number" ? text === "" ? null : Number(text) : text)} />{property.id === "title" && <button className="cell-open" aria-label={`Open ${text || "Untitled"}`} onClick={() => ops.openRow(row.id)}>Open</button>}</div>;
}
