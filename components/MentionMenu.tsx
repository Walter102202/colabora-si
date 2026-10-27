"use client";
import { useEffect, useRef } from "react";
import { isoLocalDate } from "@/components/DatePickerCalendar";
import type { Page } from "@/lib/types";
export type MentionItem = { kind: "page"; id: string; title: string; icon: string | null } | { kind: "date"; label: string; iso: string } | { kind: "pickDate" };
export function filteredMentions(pages: Record<string, Page>, pageId: string, query: string): MentionItem[] {
  const q = query.toLowerCase(), items: MentionItem[] = Object.values(pages).filter((p) => !p.isDeleted && p.id !== pageId && (p.title || "Untitled").toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 7).map((p) => ({ kind: "page", id: p.id, title: p.title || "Untitled", icon: p.icon }));
  for (const [name, delta] of [["Today", 0], ["Tomorrow", 1], ["Yesterday", -1]] as const) {
    if (!q || name.toLowerCase().includes(q)) { const date = new Date(); date.setDate(date.getDate() + delta); items.push({ kind: "date", label: `${name} · ${date.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" })}`, iso: isoLocalDate(date) }); }
  }
  if (!q || ["date", "pick", "calendar"].some((word) => word.includes(q))) items.push({ kind: "pickDate" });
  return items;
}
export default function MentionMenu({ items, index, rect, onIndex, onSelect }: { items: MentionItem[]; index: number; rect: DOMRect; onIndex: (index: number) => void; onSelect: (item: MentionItem) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [index]);
  return <div ref={panel} role="listbox" aria-label="Mentions" className="menu-panel fixed max-h-72 w-[270px] overflow-y-auto" style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - 290)), top: rect.bottom + 280 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - 286) }} onMouseDown={(event) => event.preventDefault()}><div className="section-label">Link to page or date</div>{items.map((item, i) => <button key={item.kind === "page" ? item.id : item.kind === "date" ? item.iso : "pick"} role="option" aria-selected={index === i} className={index === i ? "active" : ""} onMouseEnter={() => onIndex(i)} onClick={() => onSelect(item)}>{item.kind === "page" ? `${item.icon ?? "📄"} ${item.title}` : item.kind === "date" ? `📅 ${item.label}` : "📅 Pick a date…"}</button>)}{!items.length && <div className="p-2 text-xs text-text-tertiary">No matches</div>}</div>;
}
