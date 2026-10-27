"use client";
import { useState } from "react";
import type { Block } from "@/lib/types";
import type { BlockOps } from "@/lib/blockOps";
import { renderMath } from "@/lib/math";
export default function EquationBlock({ block, ops }: { block: Block; ops: BlockOps }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(block.equation ?? "");
  const save = () => { ops.updateBlock(block.id, { equation: draft }); setEditing(false); };
  return editing ? <div className="equation-editor"><textarea autoFocus rows={2} spellCheck={false} aria-label="Equation" placeholder={"E = mc^2  ·  \\frac{a}{b}  ·  \\sum_{i=0}^{n} x_i"} value={draft} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setDraft(block.equation ?? ""); setEditing(false); } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); } }} /><div className="flex justify-between text-xs text-text-tertiary"><span>LaTeX · ⌘↵ to save · Esc to cancel</span><span className="math-render" dangerouslySetInnerHTML={{ __html: renderMath(draft) || "&nbsp;" }} /></div></div> : <button className={`equation-block ${!block.equation ? "empty-equation" : ""}`} disabled={ops.locked} onClick={() => { setDraft(block.equation ?? ""); setEditing(true); }}>{block.equation ? <span className="math-render" dangerouslySetInnerHTML={{ __html: renderMath(block.equation) }} /> : "∑ Add a block equation"}</button>;
}
