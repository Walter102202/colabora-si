import { Textarea } from "@/components/FormControls";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { useSharedPresenceScope } from "@/lib/presence";
import { foreignPageIds } from "@/lib/foreignPages";
import { fetchMyShareLevel, fetchPageBundle, fetchSharedPage, pushSharedPage, addSharedComment, type PageBundle, type ShareLevel } from "@/lib/shares";
import { PageSyncEngine, CLIENT_TAG } from "@/lib/sync";
import { MemoryQueue } from "@/lib/opsQueue";
import { diffPageToOps } from "@/lib/pageOps";
import { useBlockConflicts } from "@/lib/syncConflicts";
import { getSupabase } from "@/lib/supabase";
import { rebaseHistory } from "@/lib/history";
import type { Page } from "@/lib/types";
import PageView from "@/components/PageView";
import ReadOnlyPage from "@/components/ReadOnlyPage";
const labels = { view: "You can view this page", comment: "You can view and comment on this page", edit: "You can edit this page" };
export default function SharedPageView({ pageId }: { pageId: string }) {
  const { user, loading } = useAuth(), [state, setState] = useState<"loading" | "denied" | "ready">("loading"), [level, setLevel] = useState<ShareLevel>("view"), [bundle, setBundle] = useState<PageBundle | null>(null), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!user) return;
    let alive = true, applying = false, editable = false, pushing = false, timer: ReturnType<typeof setTimeout> | undefined;
    const queue = new MemoryQueue();
    const inject = (id: string, page: Page | null, rebase = true) => { if (!alive) return; applying = true; foreignPageIds.add(id); useStore.setState((s) => { const pages = { ...s.pages }; if (page) pages[id] = page; else delete pages[id]; return { pages }; }); if (rebase) rebaseHistory({ pages: { [id]: page } }); applying = false; };
    const engine = new PageSyncEngine(queue, CLIENT_TAG + "-shared", { by: "human", id: user.id, at: Date.now() }, { getPage: (id) => useStore.getState().pages[id], apply: inject, send: pushSharedPage, read: fetchSharedPage, conflict: (id, conflict) => useBlockConflicts.getState().add(id, conflict), pageConflict: () => { if (alive) setError("This page changed in the cloud before your copy was saved, so the cloud version was reloaded."); } });
    const flush = async () => { if (pushing || !editable) return; pushing = true; try { if (alive) setError(""); await engine.flushPage(pageId); } catch (error) { if (alive) setError(error instanceof Error ? error.message : "Could not save changes."); } finally { pushing = false; } };
    const load = async () => {
      const access = await fetchMyShareLevel(pageId); if (!alive) return;
      if (!access) { editable = false; setState("denied"); return; } setLevel(access);
      if (access === "edit") { const row = await fetchSharedPage(pageId); if (!alive) return; if (!row) { editable = false; setState("denied"); return; } useSharedPresenceScope.setState((s) => ({ byPage: { ...s.byPage, [pageId]: row.workspace_id } })); if (!pushing) engine.receive(row, !useStore.getState().pages[pageId]); editable = true; }
      else { editable = false; let bundle = await fetchPageBundle(pageId); if (!bundle) { const row = await fetchSharedPage(pageId); if (row?.data) bundle = { page: row.data, updatedAt: Date.parse(row.updated_at), pages: {}, syncedBlocks: {}, truncated: false }; } if (!alive) return; setBundle(bundle); if (!bundle) { setState("denied"); return; } }
      setState("ready");
    };
    void load();
    const unsubscribe = useStore.subscribe((s, prev) => { const page = s.pages[pageId], before = prev.pages[pageId]; if (!editable || applying || !page || !before || page === before) return; queue.enqueue(pageId, diffPageToOps(before, page)); clearTimeout(timer); timer = setTimeout(() => void flush(), 1200); });
    const online = () => { void load(); void flush(); }; window.addEventListener("focus", online); window.addEventListener("online", online);
    const sb = getSupabase(), channel = sb?.channel("shared-" + pageId).on("postgres_changes", { event: "*", schema: "public", table: "pages", filter: "id=eq." + pageId }, () => void load()).subscribe();
    return () => { clearTimeout(timer); if (editable && queue.peek(pageId).length) void flush(); alive = false; unsubscribe(); window.removeEventListener("focus", online); window.removeEventListener("online", online); if (channel) void sb?.removeChannel(channel); useSharedPresenceScope.setState((s) => { const byPage = { ...s.byPage }; delete byPage[pageId]; return { byPage }; }); if (foreignPageIds.has(pageId)) useStore.setState((s) => { const pages = { ...s.pages }; delete pages[pageId]; return { pages }; }); };
  }, [pageId, user, refresh]);
  if (loading || (user && state === "loading")) return <p className="empty-state animate-pulse">Loading shared page…</p>;
  if (!user) return <p className="empty-state">🔒 Log in to view pages shared with you.</p>;
  if (state === "denied") return <p className="empty-state">🔒 This page isn&apos;t shared with you (or no longer exists).</p>;
  return <div className="h-full overflow-auto"><p className="bg-bg-secondary px-5 py-2 text-xs">Shared with you · {labels[level]}</p>{error && <p role="alert" className="danger px-5">{error}</p>}{level === "edit" ? <PageView pageId={pageId} /> : bundle && <ReadOnlyPage {...bundle} linkBase="/shared">{level === "comment" && <SharedCommentBox pageId={pageId} onSent={() => setRefresh((n) => n + 1)} />}</ReadOnlyPage>}</div>;
}
function SharedCommentBox({ pageId, onSent }: { pageId: string; onSent: () => void }) { const [body, setBody] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null); const send = async () => { if (!body.trim() || busy) return; setBusy(true); const error = await addSharedComment(pageId, body.trim()); setError(error); if (!error) { setBody(""); onSent(); } setBusy(false); }; return <div className="mt-6"><Textarea label="Add a comment…" className="w-full" rows={1} placeholder="Add a comment…" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} /><button className="action-button" disabled={!body.trim() || busy} onClick={() => void send()}>Send</button>{error && <p role="alert" className="danger">{error}</p>}</div>; }
