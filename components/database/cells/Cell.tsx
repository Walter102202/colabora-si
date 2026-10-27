"use client";
import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { createPortal } from "react-dom";
import { AgentPropertyCell } from "@/components/agents/AgentPropertyCell";
import DatePickerCalendar, { formatIsoDate } from "@/components/DatePickerCalendar";
import { computeCell, displayValue } from "@/lib/dbCompute";
import { newId } from "@/lib/factories";
import { isAutoProperty, OptionPills } from "@/components/database/dbShared";
import type { Database, DbProperty, DbRow, Page } from "@/lib/types";
import type { DbOps } from "@/lib/dbOps";
import PersonCell from "@/components/database/cells/PersonCell";
import FilesCell from "@/components/database/cells/FilesCell";
import RelationCell from "@/components/database/cells/RelationCell";
import { safeHref } from "@/lib/utils";
import { requestNotifyPermission } from "@/lib/push";
import { useStore } from "@/lib/store";
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
  if (isAutoProperty(property, database)) return <span className={`cell-readonly ${text.startsWith("⚠") ? "danger" : ""}`} title={text.startsWith("⚠") ? text : property.type === "id" ? "Auto-generated ID (read-only)" : "Automatically updated"}>{text || "—"}</span>;
  if (property.type === "person") return <PersonCell value={value} onChange={set} readOnly={ops.readOnly} />;
  if (property.type === "files") return <FilesCell value={value} onChange={set} readOnly={ops.readOnly} />;
  if (property.type === "relation") return <RelationCell property={property} value={value} pages={pages} onChange={set} onOpen={(id) => ops.openRow(id)} readOnly={ops.readOnly} />;
  if (ops.readOnly && ["url", "email", "phone"].includes(property.type)) return text ? <a className="cell-readonly text-accent" href={safeHref(property.type === "email" ? `mailto:${text}` : property.type === "phone" ? `tel:${text}` : text)} target="_blank" rel="noopener noreferrer">{text}</a> : <span className="cell-readonly">—</span>;
  if (ops.readOnly && property.id === "title") return <button className="cell-button font-medium hover:underline" onClick={() => ops.openRow(row.id)}>{text || "Untitled"}</button>;
  if (property.type === "checkbox") return <input className="m-1 accent-accent" aria-label={property.name} type="checkbox" checked={!!value} disabled={ops.readOnly} onChange={(event) => set(event.target.checked)} />;
  if (["select", "status", "multiSelect", "date"].includes(property.type)) {
    const select = property.type !== "date", options = (property.options ?? []).filter((o) => o.name.toLowerCase().includes(query.toLowerCase()));
    const canCreate = query.trim() && !ops.locked && !options.some((o) => o.name.toLowerCase() === query.trim().toLowerCase());
    const create = () => { if (!canCreate) return; const option = { id: newId(), name: query.trim(), color: (["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const)[query.trim().length % 9] }; ops.updateProperty(property.id, { options: [...(property.options ?? []), option] }); set(property.type === "multiSelect" ? [...(Array.isArray(value) ? value : []), option.id] : option.id); setQuery(""); if (property.type !== "multiSelect") close(); };
    return <>{property.type === "date" && !!value && !ops.readOnly && <button className="cell-remind" title="Remind me at 9:00 on this date" aria-label="Remind me at 9:00 on this date" onClick={() => { requestNotifyPermission(); useStore.getState().addReminder({ date: String(value).slice(0, 10) + "T09:00", pageId: row.pageId, text: String(row.cells.title ?? "").trim() || property.name + " reminder" }); }}><Bell size={13} /></button>}<button className="cell-button" disabled={ops.readOnly} onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}>{property.type === "date" && value ? formatIsoDate(String(value).slice(0, 10)) : text ? <OptionPills property={property} value={value} /> : <span className="text-text-tertiary">{ops.readOnly ? "—" : "Empty"}</span>}</button>{anchor && createPortal(<><button className="cell-backdrop" aria-label="Close cell editor" onClick={close} /><div className="menu-panel cell-popover" style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 256)), top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - 320)) }}>
      {select ? <><input autoFocus className="cell-input" placeholder="Search or create an option…" aria-label="Search options" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }} />{options.map((option) => <button key={option.id} onClick={() => { if (property.type === "multiSelect") { const values = Array.isArray(value) ? value : []; set(values.includes(option.id) ? values.filter((v) => v !== option.id) : [...values, option.id]); } else { set(option.id); close(); } }}><span className={`tc-${option.color}`}>●</span>{option.name}{(Array.isArray(value) ? value.includes(option.id) : value === option.id) ? " ✓" : ""}</button>)}{canCreate && <button onClick={create}>Create “{query.trim()}”</button>}</> : <DatePickerCalendar value={value ? String(value).slice(0, 10) : null} onSelect={(iso) => { set(iso); close(); }} />}
      <button onClick={() => { set(null); close(); }}>{select ? "Clear" : "Clear date"}</button>
    </div></>, document.body)}</>;
  }
  if (ops.readOnly) return <span className="cell-readonly">{text || "—"}</span>;
  return <div className="flex min-w-0 items-center"><CellInput label={property.name} value={value == null ? "" : String(value)} readOnly={ops.readOnly} type={property.type === "number" ? "number" : property.type === "email" ? "email" : property.type === "phone" ? "tel" : "text"} placeholder={property.id === "title" ? "Untitled" : property.type === "url" ? "https://" : property.type === "email" ? "name@email.com" : property.type === "phone" ? "+1…" : property.type === "person" ? "Person" : ""} onSave={(text) => set(property.type === "number" ? text === "" ? null : Number(text) : text)} />{property.id === "title" && <button className="cell-open" aria-label={`Open ${text || "Untitled"}`} onClick={() => ops.openRow(row.id)}>Open</button>}</div>;
}
