"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/components/Modal";
import { getBreadcrumb, useStore } from "@/lib/store";
import { computeCell, displayValue } from "@/lib/dbCompute";
import { stripHtml } from "@/lib/utils";
import { withViewTransition } from "@/lib/viewTransition";
import type { Block } from "@/lib/types";
function blocksText(blocks: Block[], synced: Record<string, Block[]>, seen = new Set<string>()): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "table") for (const row of b.table ?? []) for (const cell of row) parts.push(stripHtml(cell));
    else if (b.type === "columns") for (const column of b.columns ?? []) parts.push(blocksText(column.blocks, synced, seen));
    else if (b.type === "synced") { const key = b.syncedFrom ?? b.id; if (!seen.has(key)) { seen.add(key); parts.push(blocksText(synced[key] ?? [], synced, seen)); seen.delete(key); } }
    else parts.push(b.type === "code" ? b.html : stripHtml(b.html));
  }
  return parts.join(" ");
}
export default function SearchModal({ onClose }: { onClose: () => void }) {
  const pages = useStore((s) => s.pages), synced = useStore((s) => s.syncedBlocks), router = useRouter();
  const [query, setQuery] = useState(""), [index, setIndex] = useState(0);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase(), values = Object.values(pages).filter((p) => !p.isDeleted);
    if (!q) return values.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map((page) => ({ page, score: 0, snippet: "", dbName: "" }));
    const cells = new Map<string, { text: string; name: string }[]>();
    for (const page of values) if (page.database) {
      const database = page.database, props = database.properties.filter((p) => p.id !== "title" && ["text", "url", "email", "phone", "person", "select", "multiSelect", "status"].includes(p.type));
      for (const row of database.rows) cells.set(row.pageId, [...(cells.get(row.pageId) ?? []), { text: props.map((p) => displayValue(computeCell(row, p, database, pages), p, database, pages)).join(" "), name: page.title || "Untitled" }]);
    }
    return values.map((page) => {
      const title = (page.title || "Untitled").toLowerCase(), body = blocksText(page.blocks, synced ?? {}), comments = (page.comments ?? []).map((c) => c.body).join(" ");
      const cell = cells.get(page.id)?.find((c) => c.text.toLowerCase().includes(q));
      const score = (title.includes(q) ? 10 : 0) + (title.startsWith(q) ? 5 : 0) + (body.toLowerCase().includes(q) ? 3 : 0) + (comments.toLowerCase().includes(q) ? 2 : 0) + (cell ? 4 : 0);
      const text = [body, comments, cell?.text ?? ""].find((t) => t.toLowerCase().includes(q)) ?? "", at = text.toLowerCase().indexOf(q);
      return { page, score, snippet: text ? text.slice(Math.max(0, at - 20), at + 40).trim() : "", dbName: cell?.name ?? "" };
    }).filter((r) => r.score).sort((a, b) => b.score - a.score).slice(0, 12);
  }, [pages, synced, query]);
  const open = (id: string) => { onClose(); withViewTransition(() => router.push(`/p/${id}`)); };
  return <Modal title="Search pages" onClose={onClose}><div onKeyDown={(event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex(Math.min(index + 1, results.length - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setIndex(Math.max(index - 1, 0)); }
    if (event.key === "Enter" && results[index]) open(results[index].page.id);
  }}><input autoFocus className="modal-search" aria-label="Search pages" placeholder="Search pages…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} />
    <div className="modal-list">{!query && <div className="section-label">Recent</div>}{results.map((result, i) => <button className={`search-result ${i === index ? "active" : ""}`} key={result.page.id} onMouseEnter={() => setIndex(i)} onClick={() => open(result.page.id)}><span>{result.page.icon ?? "📄"}</span><span className="min-w-0 flex-1"><span className="block truncate">{result.page.title || "Untitled"}</span><span className="block truncate text-xs text-text-tertiary">{getBreadcrumb(pages, result.page.id).slice(0, -1).map((p) => p.title || "Untitled").join(" / ")}{result.snippet && ` · …${result.snippet}…`}</span></span>{result.dbName && <span className="text-xs text-text-tertiary">🗄 {result.dbName}</span>}</button>)}{!results.length && <div className="empty-state">No results found<button className="action-button" onClick={() => open(useStore.getState().createPage(null, { title: query }))}>New page</button></div>}</div>
    <div className="modal-footer">↑ ↓ to navigate · ↵ to open · esc to close</div></div></Modal>;
}
