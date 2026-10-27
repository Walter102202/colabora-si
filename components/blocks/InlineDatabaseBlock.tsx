"use client";
import DatabaseView from "@/components/database/DatabaseView";
import { useStore } from "@/lib/store";
import type { Block, Page } from "@/lib/types";
import type { BlockOps } from "@/lib/blockOps";
export default function InlineDatabaseBlock({ block, ops, pages }: { block: Block; ops: BlockOps; pages: Record<string, Page> }) {
  const page = block.pageId ? pages[block.pageId] : undefined;
  if (!page?.database) return <div className="empty-block my-2 space-y-2"><p>Link a database</p>{Object.values(pages).filter((p) => p.database && !p.isDeleted && p.id !== ops.pageId).map((p) => <button className="block w-full text-left" disabled={ops.locked} key={p.id} onClick={() => ops.updateBlock(block.id, { pageId: p.id })}>{p.icon ?? "🗃️"} {p.title || "Untitled database"}</button>)}{!Object.values(pages).some((p) => p.database && !p.isDeleted) && <p>No databases yet.</p>}{!ops.locked && <button className="text-accent" onClick={() => ops.updateBlock(block.id, { pageId: useStore.getState().createDatabasePage(ops.pageId) })}>＋ Create new database</button>}</div>;
  return <section className="my-3" contentEditable={false}><div className="mb-2 flex items-center gap-2"><input key={page.id + page.title} className="min-w-0 bg-transparent text-lg font-semibold" defaultValue={page.title} placeholder="Untitled database" readOnly={ops.locked} onBlur={(e) => { if (e.target.value !== page.title) useStore.getState().updatePage(page.id, { title: e.target.value }); }} />{page.parentId !== ops.pageId && <span className="text-[10px] uppercase text-text-tertiary">Linked</span>}</div><DatabaseView pageId={page.id} locked={ops.locked} /></section>;
}
