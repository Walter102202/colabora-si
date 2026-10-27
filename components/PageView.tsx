"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { pageStats } from "@/lib/pageStats";
import { formatRelative } from "@/lib/utils";
import BlockEditor from "@/components/BlockEditor";
import Emoji from "@/components/Emoji";
import DatabaseView from "@/components/database/DatabaseView";
import RowProperties from "@/components/database/RowProperties";
import { RowPanel } from "@/components/agents/RowPanel";
import { buildDbOps } from "@/lib/dbOps";
import { CommentThread } from "@/components/BlockCommentsPopover";
import { COVER_GRADIENTS, coverBackground, safeCover } from "@/lib/cover";
import CoverPicker from "@/components/CoverPicker";
import { withViewTransition } from "@/lib/viewTransition";
export default function PageView({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.pages[pageId]), pages = useStore((s) => s.pages), spellCheck = useStore((s) => s.settings?.spellcheck ?? true), title = useRef<HTMLDivElement>(null);
  const [coverPicker, setCoverPicker] = useState(false), [reposition, setReposition] = useState(false), [tempPos, setTempPos] = useState(50), router = useRouter();
  const drag = useRef<{ pointer: number; y: number; pos: number; height: number } | null>(null);
  useEffect(() => { if (title.current && document.activeElement !== title.current && title.current.textContent !== page?.title) title.current.textContent = page?.title ?? ""; }, [pageId, page?.title]);
  useEffect(() => { const timer = setInterval(() => useStore.getState().saveVersion(pageId, true), 120000); return () => { clearInterval(timer); useStore.getState().saveVersion(pageId, true); }; }, [pageId]);
  if (!page) return <div className="empty-state">Page not found.</div>;
  const stats = pageStats(page, pages);
  const parent = Object.values(pages).find((p) => !p.isDeleted && p.database?.rows.some((row) => row.pageId === pageId));
  const row = parent?.database?.rows.find((r) => r.pageId === pageId);
  const cover = safeCover(page.cover), gradient = cover?.startsWith("linear-gradient"), update = useStore.getState().updatePage;
  return <div className="h-full overflow-y-auto scrollbar-thin">{cover && <div className={`page-cover ${reposition ? "repositioning" : ""}`} style={{ backgroundImage: coverBackground(cover), backgroundPositionY: `${reposition ? tempPos : page.coverPosition ?? 50}%` }} onPointerDown={(e) => {
    if (!reposition || (e.target as HTMLElement).closest("button,input")) return;
    const height = e.currentTarget.clientHeight; if (!height) return;
    e.currentTarget.setPointerCapture(e.pointerId); drag.current = { pointer: e.pointerId, y: e.clientY, pos: tempPos, height };
  }} onPointerMove={(e) => { const start = drag.current; if (start?.pointer === e.pointerId) setTempPos(Math.max(0, Math.min(100, start.pos - (e.clientY - start.y) / start.height * 100))); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    {reposition && <span className="cover-drag-hint">Drag image to reposition</span>}{!page.locked && <div className={`cover-controls ${reposition ? "visible-controls" : ""}`}>{reposition ? <><button onClick={() => { update(pageId, { coverPosition: Math.round(tempPos) }); setReposition(false); }}>Save position</button><button onClick={() => setReposition(false)}>Cancel</button></> : <>{!gradient && <button onClick={() => { setTempPos(page.coverPosition ?? 50); setReposition(true); }}>Reposition</button>}<button onClick={() => setCoverPicker(!coverPicker)}>Change cover</button><button onClick={() => update(pageId, { cover: null })}>Remove</button></>}</div>}{coverPicker && <CoverPicker onSelect={(cover) => update(pageId, { cover })} onClose={() => setCoverPicker(false)} />}
  </div>}<div className={`page-content font-page-${page.font ?? "default"} ${cover ? "has-cover" : ""}`} style={{ maxWidth: page.fullWidth ? "none" : undefined, fontSize: page.smallText ? 14 : 16 }}>
    <div className="page-heading">{page.icon && <div className="mb-5"><Emoji emoji={page.icon} size={68} /></div>}
      <div className="page-hover-controls">{!page.icon && !page.locked && <button onClick={() => update(pageId, { icon: "📄" })}>Add icon</button>}{!page.cover && !page.locked && <button onClick={() => update(pageId, { cover: COVER_GRADIENTS[0] })}>Add cover</button>}</div>
      {page.locked && <div className="mb-2 rounded bg-bg-secondary px-2.5 py-1 text-xs text-text-secondary">Page locked — editing is disabled. <button className="text-accent" onClick={() => useStore.getState().updatePage(pageId, { locked: false })}>Unlock</button></div>}
      <div ref={title} className="title-edit" contentEditable={!page.locked} suppressContentEditableWarning role="textbox" aria-label="Page title" data-placeholder="Untitled" spellCheck={spellCheck} onInput={(event) => useStore.getState().updatePage(pageId, { title: event.currentTarget.textContent?.replace(/\n/g, "") ?? "" })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "ArrowDown") { event.preventDefault(); document.querySelector<HTMLElement>('[data-block-id] [contenteditable="true"]')?.focus(); } }} />
    </div>
    {parent && row && <RowProperties ops={buildDbOps(parent.id)} row={row} pages={pages} />}
    {(row || new URLSearchParams(window.location.search).has("task")) && <RowPanel pageId={pageId} />}
    {!page.database && !page.locked && page.blocks.length <= 1 && (page.blocks[0]?.type ?? "paragraph") === "paragraph" && !page.blocks[0]?.html && <button className="mt-3 text-sm text-text-tertiary" onClick={() => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind: "template", pageId } }))}>Start with a template</button>}
    <div className="pt-2">{page.database ? <DatabaseView pageId={pageId} locked={page.locked} /> : <BlockEditor pageId={pageId} />}</div>
    {!!stats.backlinks.length && <section className="mt-10 border-t border-border pt-4"><h3 className="mb-2 text-xs uppercase text-text-tertiary">↳ {stats.backlinks.length} linked {stats.backlinks.length === 1 ? "reference" : "references"}</h3>{stats.backlinks.map((linked) => <button key={linked.id} className="page-link-block" onClick={() => withViewTransition(() => router.push(`/p/${linked.id}`))}><Emoji emoji={linked.icon ?? "📄"} /><span className="border-b border-border">{linked.title || "Untitled"}</span></button>)}</section>}
    <div className="mt-8 border-t border-border pt-4"><CommentThread pageId={pageId} /></div>
    <div className="mt-8 text-xs text-text-tertiary">{!page.database && <>{stats.words} {stats.words === 1 ? "word" : "words"} · {stats.blocks} {stats.blocks === 1 ? "block" : "blocks"} · {stats.mins} min read · </>}Edited {formatRelative(page.updatedAt)}</div>
  </div></div>;
}
