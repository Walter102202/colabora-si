"use client";
import { useEffect, useRef } from "react";
import { searchEmoji, type EmojiEntry } from "@/lib/emojiData";
export default function EmojiMenu({ query, index, rect, onSelect, onIndex }: { query: string; index: number; rect: DOMRect; onSelect: (entry: EmojiEntry) => void; onIndex: (index: number) => void }) {
  const element = useRef<HTMLDivElement>(null), items = searchEmoji(query, 12);
  useEffect(() => { element.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [index]);
  return <div ref={element} className="menu-panel emoji-menu" role="listbox" aria-label="Emoji" style={{ left: Math.max(8, Math.min(rect.left, innerWidth - 280)), top: rect.bottom + 260 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - 266) }} onMouseDown={(e) => e.preventDefault()}><div className="section-label">Emoji</div>{items.map((entry, i) => <button role="option" aria-selected={i === index} className={i === index ? "active" : ""} key={entry.name} onMouseEnter={() => onIndex(i)} onClick={() => onSelect(entry)}><span className="text-xl">{entry.char}</span><span className="text-text-secondary">:{entry.name}:</span></button>)}{!items.length && <p className="p-2 text-sm text-text-tertiary">No emoji found</p>}</div>;
}
