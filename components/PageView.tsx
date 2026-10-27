"use client";
import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { pageStats } from "@/lib/pageStats";
import { formatRelative } from "@/lib/utils";
import BlockEditor from "@/components/BlockEditor";
import Emoji from "@/components/Emoji";
import DatabaseView from "@/components/database/DatabaseView";
import RowProperties from "@/components/database/RowProperties";
import { RowPanel } from "@/components/agents/RowPanel";
import { buildDbOps } from "@/lib/dbOps";
export default function PageView({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.pages[pageId]), pages = useStore((s) => s.pages), spellCheck = useStore((s) => s.settings?.spellcheck ?? true), title = useRef<HTMLDivElement>(null);
  useEffect(() => { if (title.current && document.activeElement !== title.current && title.current.textContent !== page?.title) title.current.textContent = page?.title ?? ""; }, [pageId, page?.title]);
  useEffect(() => { const timer = setInterval(() => useStore.getState().saveVersion(pageId, true), 120000); return () => { clearInterval(timer); useStore.getState().saveVersion(pageId, true); }; }, [pageId]);
  if (!page) return <div className="empty-state">Page not found.</div>;
  const stats = pageStats(page, pages);
  const parent = Object.values(pages).find((p) => !p.isDeleted && p.database?.rows.some((row) => row.pageId === pageId));
  const row = parent?.database?.rows.find((r) => r.pageId === pageId);
  return <div className="h-full overflow-y-auto scrollbar-thin"><div className={`page-content font-page-${page.font ?? "default"}`} style={{ maxWidth: page.fullWidth ? "none" : undefined, fontSize: page.smallText ? 14 : 16 }}>
    <div className="page-heading">{page.icon && <div className="mb-5"><Emoji emoji={page.icon} size={68} /></div>}
      <div className="page-hover-controls">{!page.icon && !page.locked && <button onClick={() => useStore.getState().updatePage(pageId, { icon: "📄" })}>Add icon</button>}</div>
      {page.locked && <div className="mb-2 rounded bg-bg-secondary px-2.5 py-1 text-xs text-text-secondary">Page locked — editing is disabled. <button className="text-accent" onClick={() => useStore.getState().updatePage(pageId, { locked: false })}>Unlock</button></div>}
      <div ref={title} className="title-edit" contentEditable={!page.locked} suppressContentEditableWarning role="textbox" aria-label="Page title" data-placeholder="Untitled" spellCheck={spellCheck} onInput={(event) => useStore.getState().updatePage(pageId, { title: event.currentTarget.textContent?.replace(/\n/g, "") ?? "" })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "ArrowDown") { event.preventDefault(); document.querySelector<HTMLElement>('[data-block-id] [contenteditable="true"]')?.focus(); } }} />
    </div>
    {parent && row && <RowProperties ops={buildDbOps(parent.id)} row={row} pages={pages} />}
    {(row || new URLSearchParams(window.location.search).has("task")) && <RowPanel pageId={pageId} />}
    <div className="pt-2">{page.database ? <DatabaseView pageId={pageId} /> : <BlockEditor pageId={pageId} />}</div>
    <div className="mt-8 text-xs text-text-tertiary">{!page.database && <>{stats.words} {stats.words === 1 ? "word" : "words"} · {stats.blocks} {stats.blocks === 1 ? "block" : "blocks"} · {stats.mins} min read · </>}Edited {formatRelative(page.updatedAt)}</div>
  </div></div>;
}
