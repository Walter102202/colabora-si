"use client";
import { useState } from "react";
import type { Block, Page } from "@/lib/types";
import { type BlockOps, numbering, visibleBlocks } from "@/lib/blockOps";
import { ReadOnlyDataProvider, useReadOnlyData } from "@/lib/readOnlyData";
import { coverBackground } from "@/lib/cover";
import { formatRelative } from "@/lib/utils";
import BlockItem from "@/components/blocks/BlockItem";
import ReadOnlyDatabaseView from "@/components/database/ReadOnlyDatabaseView";
const ignore = () => {};
export function ReadOnlyBlocks({ pageId, blocks }: { pageId: string; blocks: Block[] }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}), data = useReadOnlyData();
  const current = blocks.map((b) => collapsed[b.id] === undefined ? b : { ...b, collapsed: collapsed[b.id] });
  const ops: BlockOps = { pageId, locked: true, numbering: numbering(current), draggingId: null, dropTarget: null, register: ignore, handleKeyDown: ignore, handleInput: ignore, handlePaste: ignore, saveBlock: ignore, setActive: ignore, toggleChecked: ignore, toggleCollapsed: (id) => setCollapsed((s) => ({ ...s, [id]: !(s[id] ?? blocks.find((b) => b.id === id)?.collapsed) })), openBlockMenu: ignore, onBlockMouseDown: ignore, addBlockBelow: ignore, updateBlock: ignore, onDragStart: ignore, onDragOverBlock: ignore, onDrop: ignore };
  return <>{visibleBlocks(current).map((block) => <BlockItem key={block.id} block={block} ops={ops} ordinal={ops.numbering[block.id]} spellCheck={false} pages={data?.pages ?? {}} insertBlocks={ignore} />)}</>;
}
function ReadOnlyPageBody({ page, compact, databasesUnavailable, children }: { page: Page; compact?: boolean; databasesUnavailable?: boolean; children?: React.ReactNode }) {
  const data = useReadOnlyData()!, comments = (page.comments ?? []).filter((c) => !c.blockId && !c.resolved), background = coverBackground(page.cover);
  return <>{background && <div className={compact ? "h-32" : "h-[28vh] max-h-72"} style={{ backgroundImage: background, backgroundPositionY: (page.coverPosition ?? 50) + "%", backgroundSize: "cover" }} />}<article className={"page-content font-page-" + (page.font ?? "default")} style={{ maxWidth: page.fullWidth ? "none" : undefined, fontSize: page.smallText ? 15 : 16 }}>
    {page.icon && <div style={{ fontSize: compact ? 44 : 68 }}>{page.icon}</div>}<h1 className="title-edit">{page.title || "Untitled"}</h1>
    {page.database ? databasesUnavailable ? <p>Database views can&apos;t be displayed right now.</p> : <ReadOnlyDatabaseView db={page.database} pages={data.pages} onOpenRow={data.openPage} /> : <ReadOnlyBlocks pageId={page.id} blocks={page.blocks} />}
    {!!comments.length && <section className="mt-8 border-t border-border pt-4"><h2>Comments · {comments.length}</h2>{comments.map((c) => <div key={c.id} className="my-4"><p className="text-xs text-text-tertiary">🙂 {c.author || "Someone"}{c.authorType === "agent" ? " · Agent" : ""} · {formatRelative(c.createdAt)}</p><p className="whitespace-pre-wrap">{c.body}</p></div>)}</section>}{children}<p className="mt-8 text-xs text-text-tertiary">Edited {formatRelative(page.updatedAt)}</p>
  </article></>;
}
export default function ReadOnlyPage({ page, pages = {}, syncedBlocks = {}, linkBase = null, databasesUnavailable, children }: { page: Page; pages?: Record<string, Page>; syncedBlocks?: Record<string, Block[]>; linkBase?: string | null; databasesUnavailable?: boolean; children?: React.ReactNode }) {
  const [trail, setTrail] = useState<string[]>([]), allPages = { ...pages, [page.id]: page }, active = allPages[trail.at(-1) ?? ""];
  return <ReadOnlyDataProvider value={{ pages: allPages, syncedBlocks, linkBase, openPage: (id) => setTrail((s) => s.at(-1) === id ? s : [...s, id]) }}><div className="relative min-h-full"><ReadOnlyPageBody page={page} databasesUnavailable={databasesUnavailable}>{children}</ReadOnlyPageBody>{active && <div className="fixed inset-0 z-30 bg-black/20" onClick={() => setTrail([])}><section className="absolute inset-y-0 right-0 w-full max-w-2xl overflow-auto bg-bg-primary shadow-xl" onClick={(e) => e.stopPropagation()}><header className="flex h-10 items-center gap-3 border-b border-border px-3"><button onClick={() => setTrail((s) => s.slice(0, -1))}>Back</button><span className="min-w-0 flex-1 truncate">{active.title || "Untitled"}</span><button aria-label="Close" title="Close" onClick={() => setTrail([])}>×</button></header><ReadOnlyPageBody page={active} compact /></section></div>}</div></ReadOnlyDataProvider>;
}
