"use client";
import { useEffect } from "react";
import { createLinkedViews } from "@/lib/dbOps";
import DatabaseView from "@/components/database/DatabaseView";
import { useStore } from "@/lib/store";
import type { Block, Page } from "@/lib/types";
import type { BlockOps } from "@/lib/blockOps";
import { useReadOnlyData } from "@/lib/readOnlyData";
import ReadOnlyDatabaseView from "@/components/database/ReadOnlyDatabaseView";
export default function InlineDatabaseBlock({ block, ops, pages }: { block: Block; ops: BlockOps; pages: Record<string, Page> }) {
  const readOnly = useReadOnlyData();
  const page = block.pageId ? pages[block.pageId] : undefined;
  const linked = block.linkedViews !== undefined || (!!page && page.parentId !== ops.pageId);
  useEffect(() => {
    if (linked && page?.database && block.linkedViews === undefined && !readOnly && !ops.locked) ops.updateBlock(block.id, { linkedViews: createLinkedViews(page.database) });
  }, [linked, page, block.id, block.linkedViews, readOnly, ops]);
  if (readOnly) return page?.database ? <section className="my-3"><h2 className="mb-2 text-lg font-semibold">{page.title || "Untitled database"}</h2><ReadOnlyDatabaseView db={block.linkedViews?.length ? { ...page.database, views: block.linkedViews } : page.database} pages={pages} onOpenRow={readOnly.openPage} /></section> : <div className="empty-block">This database isn&apos;t available here.</div>;
  if (!page?.database) return <div className="empty-block my-2 space-y-2"><p>Link a database</p>{Object.values(pages).filter((p) => p.database && !p.isDeleted && p.id !== ops.pageId).map((p) => <button className="block w-full text-left" disabled={ops.locked} key={p.id} onClick={() => ops.updateBlock(block.id, { pageId: p.id, linkedViews: createLinkedViews(p.database!) })}>{p.icon ?? "🗃️"} {p.title || "Untitled database"}</button>)}{!Object.values(pages).some((p) => p.database && !p.isDeleted) && <p>No databases yet.</p>}{!ops.locked && <button className="text-accent" onClick={() => { const pageId = useStore.getState().createDatabasePage(ops.pageId); ops.updateBlock(block.id, { pageId, linkedViews: createLinkedViews(useStore.getState().pages[pageId].database!) }); }}>＋ Create new database</button>}</div>;
  return <section className="my-3" contentEditable={false}><div className="mb-2 flex items-center gap-2"><input key={page.id + page.title} className="min-w-0 bg-transparent text-lg font-semibold" defaultValue={page.title} placeholder="Untitled database" readOnly={ops.locked} onBlur={(e) => { if (e.target.value !== page.title) useStore.getState().updatePage(page.id, { title: e.target.value }); }} />{linked && <span className="text-[10px] uppercase text-text-tertiary">Linked</span>}</div><DatabaseView pageId={page.id} locked={ops.locked} linkedPageId={linked ? ops.pageId : undefined} linkedBlockId={linked ? block.id : undefined} /></section>;
}
