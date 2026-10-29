import { Input } from "@/components/FormControls";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { pageUrl, sharedUrl, taskUrl } from "@/lib/routes";
import Modal from "@/components/Modal";
import { getBreadcrumb, useStore } from "@/lib/store";
import { withViewTransition } from "@/lib/viewTransition";
import { getSupabase } from "@/lib/supabase";
import { useAuthStore } from "@/lib/auth";
import { hitFromRemote, rankLocal, recentHits, type SearchHit } from "@/lib/search";

export default function SearchModal({ onClose, query, onQueryChange }: { onClose: () => void; query: string; onQueryChange: (query: string) => void }) {
  const pages = useStore((s) => s.pages), synced = useStore((s) => s.syncedBlocks), navigate = useNavigate();
  const wsId = useStore((s) => s.syncWorkspaceId), user = useAuthStore((s) => s.user), serverMode = !!getSupabase() && !!wsId && !!user;
  const [index, setIndex] = useState(0), [remote, setRemote] = useState<{ query: string; hits: SearchHit[] }>({ query: "", hits: [] });
  const results = useMemo(() => !query.trim() ? recentHits(pages) : serverMode ? remote.query === query ? remote.hits : [] : rankLocal(pages, synced ?? {}, query), [pages, synced, query, serverMode, remote]);
  useEffect(() => {
    if (!serverMode || !query.trim()) return;
    let alive = true; const timer = setTimeout(() => { void getSupabase()!.rpc("search_workspace", { p_workspace_id: null, p_query: query, p_limit: 20 }).then(({ data, error }) => { if (alive && !error) setRemote({ query, hits: (Array.isArray(data) ? data : []).map(hitFromRemote).filter((h): h is SearchHit => h !== null) }); }); }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, serverMode]);
  const selected = Math.max(0, Math.min(index, results.length - 1));
  const open = (hit: SearchHit) => { onClose(); withViewTransition(() => navigate(hit.kind === "task" ? taskUrl(hit.pageId, hit.id) : pages[hit.pageId] ? pageUrl(hit.pageId) : sharedUrl(hit.pageId))); };
  return <Modal title="Search pages" onClose={onClose}><div role="presentation" onKeyDown={(event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex(Math.max(0, Math.min(selected + 1, results.length - 1))); }
    if (event.key === "ArrowUp") { event.preventDefault(); setIndex(Math.max(selected - 1, 0)); }
    if (event.key === "Enter" && results[selected]) open(results[selected]);
  }}><Input label="Search pages" focusOnMount className="modal-search" aria-label="Search pages" placeholder="Search pages…" value={query} onChange={(event) => { onQueryChange(event.target.value); setIndex(0); }} />
    <div className="modal-list">{!query && <div className="section-label">Recent</div>}{results.map((hit, i) => <button className={`search-result ${i === selected ? "active" : ""}`} key={`${hit.kind}-${hit.id}`} onMouseEnter={() => setIndex(i)} onClick={() => open(hit)}><span>{pages[hit.pageId]?.icon ?? (hit.kind === "task" ? "✅" : "📄")}</span><span className="min-w-0 flex-1"><span className="block truncate">{hit.title || "Untitled"}</span><span className="block truncate text-xs text-text-tertiary">{pages[hit.pageId] && getBreadcrumb(pages, hit.pageId).slice(0, -1).map((p) => p.title || "Untitled").join(" / ")}{hit.snippet && ` · …${hit.snippet}…`}</span></span>{hit.kind === "row" && <span className="text-xs text-text-tertiary">🗄 {pages[pages[hit.pageId]?.parentId ?? ""]?.title}</span>}{hit.kind === "task" && <span className="text-xs text-text-tertiary">Task</span>}</button>)}{!results.length && <div className="empty-state">No results found<button className="action-button" onClick={() => { const id = useStore.getState().createPage(null, { title: query }); open({ kind: "page", id, pageId: id, title: query, snippet: "", score: 0 }); }}>New page</button></div>}</div>
    <div className="modal-footer">↑ ↓ to navigate · ↵ to open · esc to close</div></div></Modal>;
}
