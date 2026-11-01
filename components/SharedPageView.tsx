import { Textarea } from "@/components/FormControls";
import { useEffect, useState } from "react";
import { useAuth, useAuthStore } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { useSharedPresenceScope } from "@/lib/presence";
import { foreignPageIds } from "@/lib/foreignPages";
import { fetchMyShareLevel, fetchPageBundle, fetchSharedPage, pushSharedPage, addSharedComment, type PageBundle, type ShareLevel } from "@/lib/shares";
import { PageSyncEngine, CLIENT_TAG } from "@/lib/sync";
import { IndexedDbQueue } from "@/lib/opsQueue";
import { diffPageToOps } from "@/lib/pageOps";
import { savePageRecovery, useBlockConflicts } from "@/lib/syncConflicts";
import { getSupabase } from "@/lib/supabase";
import { rebaseHistory } from "@/lib/history";
import type { Page } from "@/lib/types";
import PageView, { PageRecoveryNotice } from "@/components/PageView";
import ReadOnlyPage from "@/components/ReadOnlyPage";
const closingQueues = new Map<string, Promise<void>>();
const labels = { view: "You can view this page", comment: "You can view and comment on this page", edit: "You can edit this page" };
export default function SharedPageView({ pageId }: { pageId: string }) {
  const { user, loading } = useAuth(), [state, setState] = useState<"loading" | "denied" | "ready">("loading"), [level, setLevel] = useState<ShareLevel>("view"), [bundle, setBundle] = useState<PageBundle | null>(null), [error, setError] = useState(""), [refresh, setRefresh] = useState(0), [stateFor, setStateFor] = useState("");
  useEffect(() => {
    if (!user) return;
    let alive = true, applying = false, editable = false, loadVersion = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, queue: IndexedDbQueue | null = null, engine: PageSyncEngine | null = null;
    let flight: Promise<void> | null = null, opening: Promise<void> | null = null, scope = "";
    let localCopy: Page | undefined;
    const accountId = user.id;
    const active = () => alive && useAuthStore.getState().user?.id === accountId;
    const inject = (id: string, page: Page | null, rebase = true) => {
      if (!active() || (page && !editable)) return;
      localCopy = page ?? undefined;
      applying = true; foreignPageIds.add(id);
      useStore.setState((s) => { const pages = { ...s.pages }; if (page) pages[id] = page; else delete pages[id]; return { pages }; });
      if (rebase) rebaseHistory({ pages: { [id]: page } }); applying = false;
    };
    const report = (error: unknown) => { if (active()) setError(error instanceof Error ? error.message : "Could not save changes."); };
    const flush = (): Promise<void> => {
      if (flight) return flight;
      if (!active() || !editable || !engine || !navigator.onLine) return Promise.resolve();
      const currentEngine = engine;
      flight = currentEngine.flushPage(pageId).then(() => { if (active()) setError(""); }).catch(report).finally(() => { flight = null; });
      return flight;
    };
    const load = async () => {
      const version = ++loadVersion;
      const current = () => active() && version === loadVersion;
      try {
        const access = await fetchMyShareLevel(pageId); if (!current()) return;
        setStateFor(`${accountId}:${pageId}`); setError("");
        if (access !== "edit") {
          if (editable) {
            const local = useStore.getState().pages[pageId];
            if (local && queue?.peek(pageId).length) savePageRecovery(accountId, local);
          }
          editable = false;
          if (foreignPageIds.has(pageId)) inject(pageId, null);
        }
        if (!access) { setState("denied"); return; }
        setLevel(access);
        if (access === "edit") {
          const row = await fetchSharedPage(pageId); if (!current()) return;
          if (!row) { editable = false; setState("denied"); return; }
          if (!opening) opening = (async () => {
            scope = `${accountId}:${row.workspace_id}:shared:${pageId}`;
            await closingQueues.get(scope); if (!active()) return;
            let owner = sessionStorage.getItem("colabora-sync-tab");
            if (!owner) { owner = crypto.randomUUID(); sessionStorage.setItem("colabora-sync-tab", owner); }
            const opened = new IndexedDbQueue(scope, owner); queue = opened;
            await opened.ready; if (!active()) return;
            engine = new PageSyncEngine(opened, CLIENT_TAG + "-shared", { by: "human", id: accountId, at: Date.now() }, {
              getPage: () => localCopy, apply: inject,
              send: async (id, ops, client, key) => {
                if (!active() || !editable) throw new Error("Shared editing paused. Your changes are kept on this device.");
                return pushSharedPage(id, ops, client, key);
              },
              read: (id) => active() && editable ? fetchSharedPage(id) : Promise.resolve(null),
              conflict: (id, conflict) => { if (active()) useBlockConflicts.getState().add(id, conflict); },
              pageConflict: (_id, local) => savePageRecovery(accountId, local),
            });
          })();
          await opening; if (!current() || !engine || !queue) return;
          useSharedPresenceScope.setState((s) => ({ byPage: { ...s.byPage, [pageId]: row.workspace_id } }));
          editable = true;
          if (!flight) engine.receive(row, true);
          setState("ready");
          if (queue.peek(pageId).length) void flush();
        } else {
          let next = await fetchPageBundle(pageId);
          if (!next) { const row = await fetchSharedPage(pageId); if (row?.data) next = { page: row.data, updatedAt: Date.parse(row.updated_at), pages: {}, syncedBlocks: {}, truncated: false }; }
          if (!current()) return;
          setBundle(next); setState(next ? "ready" : "denied");
        }
      } catch (error) { if (current()) { report(error); setState("denied"); } }
    };
    void load();
    const unsubscribe = useStore.subscribe((s, prev) => {
      const page = s.pages[pageId], before = prev.pages[pageId];
      if (!active() || !editable || applying || !page || !before || page === before || !queue) return;
      localCopy = page;
      queue.enqueue(pageId, diffPageToOps(before, page));
      void queue.settled().catch(report);
      clearTimeout(timer); timer = setTimeout(() => void flush(), 1200);
    });
    const online = () => void load(); window.addEventListener("focus", online); window.addEventListener("online", online);
    const sb = getSupabase(), channel = sb?.channel("shared-" + pageId).on("postgres_changes", { event: "*", schema: "public", table: "pages", filter: "id=eq." + pageId }, () => void load()).subscribe((status) => { if (status === "SUBSCRIBED") void load(); });
    return () => {
      alive = false; editable = false; clearTimeout(timer); unsubscribe();
      window.removeEventListener("focus", online); window.removeEventListener("online", online);
      if (channel) void sb?.removeChannel(channel);
      if (queue) {
        const closing = queue, done = (flight ?? Promise.resolve()).finally(() => closing.close());
        closingQueues.set(scope, done);
        void done.catch(() => {}).finally(() => { if (closingQueues.get(scope) === done) closingQueues.delete(scope); });
      }
      useSharedPresenceScope.setState((s) => { const byPage = { ...s.byPage }; delete byPage[pageId]; return { byPage }; });
      if (foreignPageIds.has(pageId)) useStore.setState((s) => { const pages = { ...s.pages }; delete pages[pageId]; return { pages }; });
    };
  }, [pageId, user, refresh]);
  if (loading || (user && (state === "loading" || stateFor !== `${user.id}:${pageId}`))) return <p className="empty-state animate-pulse">Loading shared page…</p>;
  if (!user) return <p className="empty-state">🔒 Log in to view pages shared with you.</p>;
  if (state === "denied") return <><p className="empty-state">This page is unavailable or no longer shared with you.</p>{error && <p role="alert">{error}</p>}<PageRecoveryNotice pageId={pageId} userId={user.id} /></>;
  return <div className="h-full overflow-auto"><p className="bg-bg-secondary px-5 py-2 text-xs">Shared with you · {labels[level]}</p>{error && <p role="alert" className="danger px-5">{error}</p>}{level === "edit" ? <PageView pageId={pageId} /> : bundle && <ReadOnlyPage {...bundle} linkBase="/shared">{level === "comment" && <SharedCommentBox pageId={pageId} onSent={() => setRefresh((n) => n + 1)} />}</ReadOnlyPage>}</div>;
}
function SharedCommentBox({ pageId, onSent }: { pageId: string; onSent: () => void }) { const [body, setBody] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null); const send = async () => { if (!body.trim() || busy) return; setBusy(true); const error = await addSharedComment(pageId, body.trim()); setError(error); if (!error) { setBody(""); onSent(); } setBusy(false); }; return <div className="mt-6"><Textarea label="Add a comment…" className="w-full" rows={1} placeholder="Add a comment…" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} /><button className="action-button" disabled={!body.trim() || busy} onClick={() => void send()}>Send</button>{error && <p role="alert" className="danger">{error}</p>}</div>; }
