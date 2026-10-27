"use client";
import { useEffect, useRef, useState } from "react";
import { applyColor, applyFormat, createLink, type InlineFormat } from "@/lib/formatting";
import { BG_COLORS, TEXT_COLORS } from "@/lib/utils";
import { SLASH_ITEMS } from "@/lib/blockMeta";
import type { BlockType } from "@/lib/types";
export default function InlineToolbar({ range, rect, onChange, onTurnInto, onComment, onClose, initialLink = false, locked = false }: { range: Range; rect: DOMRect; onChange: () => void; onTurnInto?: (type: BlockType) => void; onComment?: () => void; onClose: () => void; initialLink?: boolean; locked?: boolean }) {
  const saved = useRef(range.cloneRange()), [panel, setPanel] = useState(initialLink ? "link" : ""), [url, setUrl] = useState("");
  useEffect(() => { saved.current = range.cloneRange(); }, [range]);
  const restore = () => { const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(saved.current); };
  const run = (fn: () => void) => { restore(); fn(); onChange(); };
  return <div className="inline-toolbar menu-panel" style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - 380)), top: Math.max(8, rect.top - 44) }} onMouseDown={(event) => event.preventDefault()}>
    {onComment && !locked && <button aria-label="Comment on block" onClick={onComment}>💬</button>}
    {onTurnInto && !locked && <button aria-label="Turn into" onClick={() => setPanel(panel === "types" ? "" : "types")}>Text ▾</button>}
    {(["bold", "italic", "underline", "strike", "code"] as InlineFormat[]).map((format, i) => <button key={format} aria-label={format} disabled={locked} onClick={() => run(() => applyFormat(format))}>{["B", "I", "U", "S", "</>"][i]}</button>)}
    <button aria-label="Link" disabled={locked} onClick={() => setPanel(panel === "link" ? "" : "link")}>↗</button><button aria-label="Color" disabled={locked} onClick={() => setPanel(panel === "colors" ? "" : "colors")}>A ▾</button>
    {panel === "link" && <form className="menu-panel absolute left-0 top-full mt-1 flex w-64 gap-2" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); run(() => createLink(url)); onClose(); }}><input autoFocus aria-label="Link URL" placeholder="Paste link…" value={url} onChange={(event) => setUrl(event.target.value)} className="min-w-0 flex-1" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} /><button type="submit">Add</button></form>}
    {panel === "colors" && <div className="menu-panel absolute left-0 top-full mt-1 max-h-72 w-52 overflow-auto">{[...TEXT_COLORS, ...BG_COLORS].map((color) => <button key={color.key} onClick={() => { run(() => applyColor(color.cls || null)); onClose(); }}>{color.label}</button>)}</div>}
    {panel === "types" && <div className="menu-panel absolute left-0 top-full mt-1 max-h-72 w-52 overflow-auto">{SLASH_ITEMS.filter((item) => item.type !== "divider").map((item) => <button key={item.type} onClick={() => { onTurnInto?.(item.type); onClose(); }}>{item.title}</button>)}</div>}
  </div>;
}
