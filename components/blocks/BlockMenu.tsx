import { useEffect, useRef, useState } from "react";
import type { Block, BlockColor, BlockType } from "@/lib/types";
import { BLOCK_LABELS, SLASH_ITEMS } from "@/lib/blockMeta";
import { BG_COLORS, TEXT_COLORS } from "@/lib/utils";
export default function BlockMenu({ block, rect, onClose, onType, onUpdate, onDuplicate, onDelete, onComment, onMove, canMoveOut, columns, onMoveToColumn }: { block: Block; rect: DOMRect; onClose: () => void; onType: (type: BlockType) => void; onUpdate: (patch: Partial<Block>) => void; onDuplicate: () => void; onDelete: () => void; onComment?: () => void; onMove?: (direction: "up" | "down" | "out") => void; canMoveOut?: boolean; columns?: { id: string; label: string }[]; onMoveToColumn?: (id: string) => void }) {
  const element = useRef<HTMLDivElement>(null), [panel, setPanel] = useState("main");
  useEffect(() => { const close = (event: MouseEvent) => { if (!element.current?.contains(event.target as Node)) onClose(); }; const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; document.addEventListener("mousedown", close); document.addEventListener("keydown", key); return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); }; }, [onClose]);
  const done = (fn: () => void) => { fn(); onClose(); };
  return <div ref={element} role="menu" className="menu-panel fixed max-h-96 w-56 overflow-y-auto" style={{ top: Math.max(8, Math.min(rect.top, window.innerHeight - 380)), left: Math.max(8, Math.min(rect.right + 4, window.innerWidth - 232)) }}>
    {panel === "types" ? SLASH_ITEMS.filter((i) => i.type !== "divider" && !i.provider && !i.variant).map((item) => <button role="menuitem" key={item.type} onClick={() => done(() => onType(item.type))}>{BLOCK_LABELS[item.type]}{block.type === item.type ? " ✓" : ""}</button>) : panel === "colors" ? [...TEXT_COLORS, ...BG_COLORS].map((color) => <button role="menuitem" key={color.key} onClick={() => done(() => onUpdate({ color: color.key as BlockColor }))}><span className={color.cls}>A</span>{color.label}</button>) : <>
      <button role="menuitem" onClick={() => setPanel("types")}>Turn into</button><button role="menuitem" onClick={() => setPanel("colors")}>Color</button>
      {block.type.startsWith("heading") && <button role="menuitem" onClick={() => done(() => onUpdate({ toggleable: !block.toggleable, collapsed: false }))}>{block.toggleable ? "Remove toggle" : "Toggle heading"}</button>}
      {onMove && <><button role="menuitem" onClick={() => done(() => onMove("up"))}>Move up</button><button role="menuitem" onClick={() => done(() => onMove("down"))}>Move down</button>{canMoveOut && <button role="menuitem" onClick={() => done(() => onMove("out"))}>Move out of column</button>}</>}
      {columns?.map((column) => <button role="menuitem" key={column.id} onClick={() => done(() => onMoveToColumn?.(column.id))}>Move to {column.label.toLowerCase()}</button>)}
      {onComment && <button role="menuitem" onClick={() => done(onComment)}>Comment</button>}
      <button role="menuitem" onClick={() => done(() => { void navigator.clipboard.writeText(location.origin + location.pathname + "#" + block.id); })}>Copy link to block</button><button role="menuitem" onClick={() => done(onDuplicate)}>Duplicate</button><button role="menuitem" className="danger" onClick={() => done(onDelete)}>Delete</button>
    </>}
  </div>;
}
