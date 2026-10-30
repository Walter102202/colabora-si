import { useIdleSnapshot } from "@/lib/versionSnapshots";
import { useBlockConflicts } from "@/lib/syncConflicts";
import { lazy, Suspense } from "react";
import { pageUrl } from "@/lib/routes";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useStore } from "@/lib/store";
import { pageStats } from "@/lib/pageStats";
import { formatRelative } from "@/lib/utils";
import BlockEditor from "@/components/BlockEditor";
import Emoji from "@/components/Emoji";
const DatabaseView = lazy(() => import("@/components/database/DatabaseView"));
import RowProperties from "@/components/database/RowProperties";
import { RowPanel } from "@/components/agents/RowPanel";
import { AiRequestToasts } from "@/components/agents/AiRequestToasts";
import { getSupabase } from "@/lib/supabase";
import { buildDbOps } from "@/lib/dbOps";
import { CommentThread } from "@/components/BlockCommentsPopover";
import { COVER_GRADIENTS, coverBackground, safeCover } from "@/lib/cover";
import CoverPicker from "@/components/CoverPicker";
const EmojiPicker = lazy(() => import("@/components/EmojiPicker"));
import { withViewTransition } from "@/lib/viewTransition";
export default function PageView({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.pages[pageId]), pages = useStore((s) => s.pages), spellCheck = useStore((s) => s.settings?.spellcheck ?? true), title = useRef<HTMLDivElement>(null);
  const [coverPicker, setCoverPicker] = useState(false), [reposition, setReposition] = useState(false), [tempPos, setTempPos] = useState(50), navigate = useNavigate();
  const [params] = useSearchParams();
  const [iconPicker, setIconPicker] = useState(false);
  const drag = useRef<{ pointer: number; y: number; pos: number; height: number } | null>(null);
  useEffect(() => { if (title.current && document.activeElement !== title.current && title.current.textContent !== page?.title) title.current.textContent = page?.title ?? ""; }, [pageId, page?.title]);
  useIdleSnapshot(pageId);
  const reloaded = useBlockConflicts((s) => s.pageReloads[pageId]);
  if (!page) return <div className="empty-state">Page not found.</div>;
  const stats = pageStats(page, pages);
  const parent = Object.values(pages).find((p) => !p.isDeleted && p.database?.rows.some((row) => row.pageId === pageId));
  const row = parent?.database?.rows.find((r) => r.pageId === pageId);
  const cover = safeCover(page.cover), gradient = cover?.startsWith("linear-gradient"), update = useStore.getState().updatePage;
  return <div className="h-full overflow-y-auto scrollbar-thin"><title>{`${page.title || "Untitled"} · colabora.si`}</title>{cover && <div className={`page-cover ${reposition ? "repositioning" : ""}`} style={{ backgroundImage: coverBackground(cover), backgroundPositionY: `${reposition ? tempPos : page.coverPosition ?? 50}%` }} onPointerDown={(e) => {
    if (!reposition || (e.target as HTMLElement).closest("button,input")) return;
    const height = e.currentTarget.clientHeight; if (!height) return;
    e.currentTarget.setPointerCapture(e.pointerId); drag.current = { pointer: e.pointerId, y: e.clientY, pos: tempPos, height };
  }} onPointerMove={(e) => { const start = drag.current; if (start?.pointer === e.pointerId) setTempPos(Math.max(0, Math.min(100, start.pos - (e.clientY - start.y) / start.height * 100))); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    {reposition && <span className="cover-drag-hint">Drag image to reposition</span>}{!page.locked && <div className={`cover-controls ${reposition ? "visible-controls" : ""}`}>{reposition ? <><button onClick={() => { update(pageId, { coverPosition: Math.round(tempPos) }); setReposition(false); }}>Save position</button><button onClick={() => setReposition(false)}>Cancel</button></> : <>{!gradient && <button onClick={() => { setTempPos(page.coverPosition ?? 50); setReposition(true); }}>Reposition</button>}<button onClick={() => setCoverPicker(!coverPicker)}>Change cover</button><button onClick={() => update(pageId, { cover: null })}>Remove</button></>}</div>}{coverPicker && <CoverPicker onSelect={(cover) => update(pageId, { cover })} onClose={() => setCoverPicker(false)} />}
  </div>}<div className={`page-content font-page-${page.font ?? "default"} ${cover ? "has-cover" : ""}`} style={{ maxWidth: page.fullWidth ? "none" : undefined, fontSize: page.smallText ? 14 : 16 }}>
    <div className="page-heading">{page.icon && <div className="relative mb-5"><button className="page-icon-button" disabled={page.locked} aria-label="Change page icon" onClick={() => setIconPicker(!iconPicker)}><Emoji emoji={page.icon} size={68} /></button>{iconPicker && <Suspense fallback={null}><EmojiPicker onSelect={(icon) => update(pageId, { icon })} onRemove={() => update(pageId, { icon: null })} onClose={() => setIconPicker(false)} /></Suspense>}</div>}
      <div className="page-hover-controls">{!page.icon && !page.locked && <button onClick={() => update(pageId, { icon: "📄" })}>Add icon</button>}{!page.cover && !page.locked && <button onClick={() => update(pageId, { cover: COVER_GRADIENTS[0] })}>Add cover</button>}</div>
      {page.locked && <div className="mb-2 rounded bg-bg-secondary px-2.5 py-1 text-xs text-text-secondary">Page locked — editing is disabled. <button className="text-accent" onClick={() => useStore.getState().updatePage(pageId, { locked: false })}>Unlock</button></div>}
      {reloaded && <p role="status" className="mb-2 rounded bg-bg-secondary px-2.5 py-1 text-xs text-text-secondary">This page changed in the cloud before your copy was saved, so the cloud version was reloaded. <button className="text-accent" onClick={() => useBlockConflicts.getState().dismissPageReload(pageId)}>Dismiss</button></p>}
      <div ref={title} className="title-edit" contentEditable={!page.locked} suppressContentEditableWarning role="textbox" tabIndex={0} aria-label="Page title" data-placeholder="Untitled" spellCheck={spellCheck} onInput={(event) => useStore.getState().updatePage(pageId, { title: event.currentTarget.textContent?.replace(/\n/g, "") ?? "" })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "ArrowDown") { event.preventDefault(); document.querySelector<HTMLElement>('[data-block-id] [contenteditable="true"]')?.focus(); } }} />
    </div>
    {parent && row && <RowProperties ops={buildDbOps(parent.id)} row={row} pages={pages} />}
    {(row || params.has("task")) && <RowPanel pageId={pageId} />}
    {getSupabase() && <AiRequestToasts pageId={pageId} />}
    {!page.database && !page.locked && page.blocks.length <= 1 && (page.blocks[0]?.type ?? "paragraph") === "paragraph" && !page.blocks[0]?.html && <button className="mt-3 text-sm text-text-tertiary" onClick={() => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind: "template", pageId } }))}>Start with a template</button>}
    <div className="pt-2">{page.database ? <Suspense fallback={null}><DatabaseView pageId={pageId} locked={page.locked} /></Suspense> : <BlockEditor pageId={pageId} />}</div>
    {!!stats.backlinks.length && <section className="mt-10 border-t border-border pt-4"><h3 className="mb-2 text-xs uppercase text-text-tertiary">↳ {stats.backlinks.length} linked {stats.backlinks.length === 1 ? "reference" : "references"}</h3>{stats.backlinks.map((linked) => <button key={linked.id} className="page-link-block" onClick={() => withViewTransition(() => navigate(pageUrl(linked.id)))}><Emoji emoji={linked.icon ?? "📄"} /><span className="border-b border-border">{linked.title || "Untitled"}</span></button>)}</section>}
    <div className="mt-8 border-t border-border pt-4"><CommentThread pageId={pageId} /></div>
    <div className="mt-8 text-xs text-text-tertiary">{!page.database && <>{stats.words} {stats.words === 1 ? "word" : "words"} · {stats.blocks} {stats.blocks === 1 ? "block" : "blocks"} · {stats.mins} min read · </>}Edited {formatRelative(page.updatedAt)}</div>
  </div></div>;
}
