"use client";
import { useState } from "react";
import Modal from "@/components/Modal";
import { getBreadcrumb, useStore } from "@/lib/store";
import { wouldCycle } from "@/lib/pageMutations";
export default function MovePageModal({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const pages = useStore((s) => s.pages), [query, setQuery] = useState(""), [index, setIndex] = useState(0), page = pages[pageId];
  if (!page) return null;
  const q = query.trim().toLowerCase();
  const targets = Object.values(pages).filter((p) => !p.isDeleted && p.id !== page.parentId && !wouldCycle(pages, pageId, p.id) && (p.title || "Untitled").toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
  const choices = [...(page.parentId !== null && "root".includes(q) ? [{ id: null, title: "Move to top level (root)", icon: "🏠" }] : []), ...targets];
  const move = (id: string | null) => { useStore.getState().movePage(pageId, id); onClose(); };
  return <Modal title={`Move “${page.title || "Untitled"}” to…`} onClose={onClose}><div onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setIndex(Math.min(index + 1, choices.length - 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setIndex(Math.max(index - 1, 0)); } if (event.key === "Enter" && choices[index]) move(choices[index].id); }}>
    <input className="modal-search" autoFocus aria-label="Search destinations" placeholder="Search pages…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} /><div className="modal-list">{choices.map((target, i) => <button key={target.id ?? "root"} className={`search-result ${i === index ? "active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => move(target.id)}><span>{target.icon ?? "📄"}</span><span>{target.title || "Untitled"}{target.id && <span className="block text-xs text-text-tertiary">{getBreadcrumb(pages, target.id).slice(0, -1).map((p) => p.title || "Untitled").join(" / ")}</span>}</span></button>)}{!choices.length && <div className="empty-state">No pages found<button className="action-button" onClick={onClose}>Cancel</button></div>}</div><div className="modal-footer">↑ ↓ to navigate · ↵ to move · esc to close</div></div></Modal>;
}
