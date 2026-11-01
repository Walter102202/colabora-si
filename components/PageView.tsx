import { useIdleSnapshot } from "@/lib/versionSnapshots";
import { dismissPageRecovery, loadPageRecoveries, pageRecoveryCopies, usePageRecoveries, useBlockConflicts } from "@/lib/syncConflicts";
import { useAuthStore } from "@/lib/auth";
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
import { taskForPage, useAgentTasks } from "@/lib/agentTasks";
import { useBacklinks, usePageBodies } from "@/lib/usePageBodies";
import { databaseDeps } from "@/lib/pageBodies";
import type { Page } from "@/lib/types";
export default function PageView({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.pages[pageId]), pages = useStore((s) => s.pages), spellCheck = useStore((s) => s.settings?.spellcheck ?? true), title = useRef<HTMLDivElement>(null);
  const task = useAgentTasks((state) => taskForPage(state, pageId));
  const [coverPicker, setCoverPicker] = useState(false), [reposition, setReposition] = useState(false), [tempPos, setTempPos] = useState(50), navigate = useNavigate();
  const [params] = useSearchParams();
  const [iconPicker, setIconPicker] = useState(false);
  const drag = useRef<{ pointer: number; y: number; pos: number; height: number } | null>(null);
  const host = page?.parentId && pages[page.parentId]?.database ? page.parentId : null;
  const bodies = usePageBodies(host ? [pageId, ...databaseDeps(host, pages)] : [pageId]);
  const backlinks = useBacklinks(pageId);
  useEffect(() => { if (title.current && document.activeElement !== title.current && title.current.textContent !== page?.title) title.current.textContent = page?.title ?? ""; }, [pageId, page?.title, bodies]);
  useIdleSnapshot(pageId);
  const reloaded = useBlockConflicts((s) => s.pageReloads[pageId]);
  if (!page) return <div className="empty-state">Page not found.</div>;
  if (bodies !== "ready") return <PageBodyPlaceholder page={page} state={bodies} />;
  const stats = pageStats(page);
  const parent = host && !pages[host].isDeleted ? pages[host] : undefined;
  const row = parent?.database?.rows.find((r) => r.pageId === pageId);
  const job = row && !row.parentRowId && !task?.parent_task_id && parent?.database?.properties.some((property) => property.type === "agentStatus");
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
      <PageRecoveryNotice pageId={pageId} />
      {reloaded && <p role="status" className="mb-2 rounded bg-bg-secondary px-2.5 py-1 text-xs text-text-secondary">This page changed in the cloud. The cloud version was reloaded. <button className="text-accent" onClick={() => useBlockConflicts.getState().dismissPageReload(pageId)}>Dismiss</button></p>}
      <div ref={title} className="title-edit" contentEditable={!page.locked} suppressContentEditableWarning role="textbox" tabIndex={0} aria-label="Page title" data-placeholder="Untitled" spellCheck={spellCheck} onInput={(event) => useStore.getState().updatePage(pageId, { title: event.currentTarget.textContent?.replace(/\n/g, "") ?? "" })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "ArrowDown") { event.preventDefault(); document.querySelector<HTMLElement>('[data-block-id] [contenteditable="true"]')?.focus(); } }} />
    </div>
    {parent && row && <RowProperties ops={buildDbOps(parent.id)} row={row} pages={pages} />}
    {(row || params.has("task")) && <RowPanel pageId={pageId} />}
    {getSupabase() && <AiRequestToasts pageId={pageId} />}
    {!job && !page.database && !page.locked && page.blocks.length <= 1 && (page.blocks[0]?.type ?? "paragraph") === "paragraph" && !page.blocks[0]?.html && <button className="mt-3 text-sm text-text-tertiary" onClick={() => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind: "template", pageId } }))}>Start with a template</button>}
    <div className="pt-2">{page.database ? <Suspense fallback={null}><DatabaseView pageId={pageId} locked={page.locked} /></Suspense> : <BlockEditor pageId={pageId} emptyHint={job ? "Write the plan here. The Lead reads it when it starts." : undefined} />}</div>
    {!!backlinks.length &&<section className="mt-10 border-t border-border pt-4"><h3 className="mb-2 text-xs uppercase text-text-tertiary">↳ {backlinks.length} linked {backlinks.length === 1 ? "reference" : "references"}</h3>{backlinks.map((linked) => <button key={linked.id} className="page-link-block" onClick={() => withViewTransition(() => navigate(pageUrl(linked.id)))}><Emoji emoji={linked.icon ?? "📄"} /><span className="border-b border-border">{linked.title || "Untitled"}</span></button>)}</section>}
    <div className="mt-8 border-t border-border pt-4"><CommentThread pageId={pageId} /></div>
    <div className="mt-8 text-xs text-text-tertiary">{!page.database && <>{stats.words} {stats.words === 1 ? "word" : "words"} · {stats.blocks} {stats.blocks === 1 ? "block" : "blocks"} · {stats.mins} min read · </>}Edited {formatRelative(page.updatedAt)}</div>
  </div></div>;
}

function PageBodyPlaceholder({ page, state }: { page: Page; state: "loading" | "unavailable" }) {
  return <div className="h-full overflow-y-auto scrollbar-thin">
    <title>{`${page.title || "Untitled"} · colabora.si`}</title>
    <div className={`page-content font-page-${page.font ?? "default"}`} style={{ maxWidth: page.fullWidth ? "none" : undefined }}>
      {page.icon && <div className="mb-5"><Emoji emoji={page.icon} size={68} /></div>}
      <PageRecoveryNotice pageId={page.id} />
      <h1 className="title-edit">{page.title || "Untitled"}</h1>
      {state === "loading" ? <div className="page-body-skeleton" aria-busy="true" aria-label="Loading page"><div /><div /><div /></div>
        : <p className="mt-4 text-text-secondary">This page isn&apos;t on this device yet. Connect to the internet to open it.</p>}
    </div>
  </div>;
}

export function PageRecoveryNotice({ pageId, userId: account }: { pageId: string; userId?: string }) {
  const signedIn = useAuthStore((s) => s.user?.id), userId = account ?? signedIn;
  const copies = usePageRecoveries((s) => userId ? s.copies[`colabora-recovery:${userId}:${pageId}`] : undefined);
  const savedError = usePageRecoveries((s) => userId ? s.errors[`colabora-recovery:${userId}:${pageId}`] : undefined);
  const [actionError, setError] = useState("");
  const error = savedError || actionError;
  useEffect(() => { if (userId) loadPageRecoveries(userId, pageId); }, [userId, pageId]);
  if (!userId || (!copies?.length && !error)) return null;
  return <section aria-label="Saved local copies" className="mb-2 rounded bg-bg-secondary px-3 py-2 text-sm">
    <p>Your unsaved copy is kept on this device. Download it to recover your work.</p>
    {copies?.map((copy) => <div key={copy.id}>
      <button className="text-accent mr-3" onClick={() => {
        const saved = pageRecoveryCopies(userId, pageId)?.find((item) => item.id === copy.id); if (!saved) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(saved.page, null, 2)], { type: "application/json" }));
        const a = document.createElement("a"); a.href = url; a.download = `page-${pageId}-${copy.at}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Download local copy ({new Date(copy.at).toLocaleString()})</button>
      <button onClick={() => { if (confirm("Delete this saved local copy from this device?")) { try { dismissPageRecovery(userId, pageId, copy.id); } catch { setError("Could not remove the saved copy."); } } }}>Delete saved copy</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
