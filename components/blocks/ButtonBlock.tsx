"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { runAgentAction } from "@/lib/agentActions";
import { createBlock, newId } from "@/lib/factories";
import { withViewTransition } from "@/lib/viewTransition";
import type { Block, ButtonAction, Page } from "@/lib/types";
import type { BlockOps } from "@/lib/blockOps";
import NestedEditor from "@/components/blocks/NestedEditor";
export default function ButtonBlock({ block, ops, pages, onInsert }: { block: Block; ops: BlockOps; pages: Record<string, Page>; onInsert: (blocks: Block[]) => void }) {
  const [open, setOpen] = useState(false), [done, setDone] = useState(false), [query, setQuery] = useState("");
  const running = useRef(false), router = useRouter(), actions = block.buttonActions ?? [];
  const update = (next: ButtonAction[]) => ops.updateBlock(block.id, { buttonActions: next });
  const run = async () => {
    if (ops.locked || running.current) return;
    if (!actions.length) { setOpen(true); return; }
    running.current = true;
    try {
      let destination: string | null = null;
      for (const action of actions) {
        if (action.kind === "agentTask") await runAgentAction(action, { pageId: ops.pageId });
        else if (action.kind === "insertBlocks") onInsert(action.blocks.length ? action.blocks : [createBlock()]);
        else if (action.pageId) destination = action.pageId;
      }
      setDone(true); setTimeout(() => setDone(false), 1200);
      if (destination) withViewTransition(() => router.push(`/p/${destination}`));
    } finally { running.current = false; }
  };
  return <div className="relative my-2"><button className="action-button" disabled={ops.locked} onClick={() => void run()}>{done ? "✓" : "↖"} {block.buttonLabel || "New button"}</button>{!ops.locked && <button className="icon-button" aria-label="Configure button" onClick={() => setOpen(!open)}>⚙</button>}
    {open && <><button className="menu-backdrop" aria-label="Close button configuration" onClick={() => setOpen(false)} /><div className="menu-panel absolute left-0 top-full mt-1 w-96 max-w-[calc(100vw-2rem)]"><label className="section-label">Button label<input className="cell-input" defaultValue={block.buttonLabel || "New button"} onBlur={(event) => ops.updateBlock(block.id, { buttonLabel: event.target.value })} /></label><div className="section-label">Actions</div>{actions.map((action) => <div className="mb-2 rounded border border-border p-2" key={action.id}><div className="flex justify-between text-xs"><span>{action.kind === "insertBlocks" ? "Insert blocks below" : action.kind === "openPage" ? "Open page" : "Agent task"}</span><button aria-label="Remove action" onClick={() => update(actions.filter((a) => a.id !== action.id))}>×</button></div>
      {action.kind === "insertBlocks" ? <div className="max-h-56 overflow-y-auto px-8"><NestedEditor pageId={ops.pageId} blocks={action.blocks} onChange={(blocks) => update(actions.map((a) => a.id === action.id ? { ...action, blocks } : a))} /></div> : action.kind === "openPage" ? <><input className="cell-input" placeholder="Search pages…" value={query} onChange={(event) => setQuery(event.target.value)} />{Object.values(pages).filter((p) => !p.isDeleted && p.title.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map((page) => <button className="block w-full px-2 text-left text-sm" key={page.id} onClick={() => update(actions.map((a) => a.id === action.id ? { ...action, pageId: page.id } : a))}>{action.pageId === page.id ? "✓ " : ""}{page.title || "Untitled"}</button>)}</> : <><select aria-label="Agent task action" value={action.mode} onChange={(event) => update(actions.map((a) => a.id === action.id ? { ...action, mode: event.target.value as "new" | "continue" | "stop" | "approve" } : a))}>{["new", "continue", "stop", "approve"].map((mode) => <option key={mode}>{mode}</option>)}</select><input className="cell-input" placeholder="Message" defaultValue={action.message ?? ""} onBlur={(event) => update(actions.map((a) => a.id === action.id ? { ...action, message: event.target.value } : a))} /></>}
    </div>)}{!actions.length && <p className="p-2 text-xs text-text-tertiary">No actions yet — add one below.</p>}<button onClick={() => update([...actions, { id: newId(), kind: "insertBlocks", blocks: [createBlock()] }])}>Insert blocks below</button><button onClick={() => update([...actions, { id: newId(), kind: "openPage", pageId: null }])}>Open page</button><button onClick={() => update([...actions, { id: newId(), kind: "agentTask", mode: "new" }])}>Agent task</button><button onClick={() => setOpen(false)}>Done</button></div></>}
  </div>;
}
