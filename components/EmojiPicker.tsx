"use client";
import { useEffect, useRef, useState } from "react";
import { EMOJI_GROUPS, EMOJI_LIST } from "@/lib/emojiData";
export default function EmojiPicker({ onSelect, onClose, onRemove }: { onSelect: (emoji: string) => void; onClose: () => void; onRemove?: () => void }) {
  const [query, setQuery] = useState(""), panel = useRef<HTMLDivElement>(null);
  useEffect(() => { const outside = (e: MouseEvent) => { if (!panel.current?.contains(e.target as Node)) onClose(); }; const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }; document.addEventListener("mousedown", outside); document.addEventListener("keydown", key); return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", key); }; }, [onClose]);
  const q = query.trim().toLowerCase(), seen = new Set<string>(), all = EMOJI_GROUPS.flatMap((g) => g.emojis);
  const results = [...EMOJI_LIST.filter((e) => e.name.startsWith(q)), ...EMOJI_LIST.filter((e) => e.name.includes(q))].filter((e) => { if (seen.has(e.char)) return false; seen.add(e.char); return true; }).slice(0, 64);
  const select = (char: string) => { onSelect(char); onClose(); };
  return <div ref={panel} className="menu-panel emoji-picker"><div className="flex gap-1"><input className="min-w-0 flex-1" autoFocus placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />{onRemove && <button onClick={() => { onRemove(); onClose(); }}>Remove</button>}<button title="Random" aria-label="Random emoji" onClick={() => select(all[Math.floor((query.length * 7) % all.length)])}>🎲</button></div><div className="max-h-[260px] overflow-y-auto">{q ? <div className="emoji-grid">{results.map((entry) => <button key={entry.char} title={entry.name} onClick={() => select(entry.char)}>{entry.char}</button>)}</div> : EMOJI_GROUPS.map((group) => <section key={group.name}><h3 className="section-label">{group.name}</h3><div className="emoji-grid">{group.emojis.map((char, i) => <button key={i} onClick={() => select(char)}>{char}</button>)}</div></section>)}</div></div>;
}
