import { useEffect, useRef } from "react";
import { filterSlashItems, type SlashItem } from "@/lib/blockMeta";
export default function SlashMenu({ query, index, rect, onIndex, onSelect, nested = false }: { query: string; index: number; rect: { top: number; left: number; bottom: number }; onIndex: (index: number) => void; onSelect: (item: SlashItem) => void; nested?: boolean }) {
  const element = useRef<HTMLDivElement>(null), items = filterSlashItems(query, nested);
  useEffect(() => { element.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [index]);
  return <div ref={element} className="menu-panel slash-menu" role="listbox" tabIndex={-1} aria-label="Block types" style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - 324)), top: rect.bottom + 320 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - 326) }} onMouseDown={(event) => event.preventDefault()}>
    {items.map((item, i) => <div key={item.title}>{(i === 0 || item.group !== items[i - 1].group) && <div className="section-label">{item.group}</div>}<button role="option" aria-selected={i === index} className={`slash-item ${i === index ? "active" : ""}`} onMouseEnter={() => onIndex(i)} onClick={() => onSelect(item)}><span className="slash-icon">{item.icon}</span><span className="min-w-0"><span className="block text-sm font-medium">{item.title}</span><span className="block truncate text-xs text-text-tertiary">{item.description}</span></span></button></div>)}
    {!items.length && <div className="p-3 text-sm text-text-tertiary">No results</div>}
  </div>;
}
