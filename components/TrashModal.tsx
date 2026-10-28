import { Input } from "@/components/FormControls";
import { pageUrl } from "@/lib/routes";
import { useState } from "react";
import { useNavigate } from "react-router";
import { RotateCcw, Trash2 } from "lucide-react";
import Modal from "@/components/Modal";
import { getTrash, useStore } from "@/lib/store";
export default function TrashModal({ onClose }: { onClose: () => void }) {
  const pages = useStore((s) => s.pages), navigate = useNavigate(), [query, setQuery] = useState("");
  const trash = getTrash(pages), filtered = trash.filter((p) => (p.title || "Untitled").toLowerCase().includes(query.toLowerCase()));
  return <Modal title="Trash" onClose={onClose}><Input label="Search trash" className="modal-search" aria-label="Search trash" placeholder="Search trash…" value={query} onChange={(event) => setQuery(event.target.value)} />{trash.length > 0 && <div className="px-4 py-2"><button className="action-button danger" onClick={() => { if (confirm("Permanently delete all pages in Trash?")) useStore.getState().emptyTrash(); }}>Empty trash</button></div>}<div className="modal-list">
    {filtered.map((page) => <div className="search-result group" key={page.id}><span>{page.icon ?? "📄"}</span><span className="min-w-0 flex-1 truncate">{page.title || "Untitled"}</span><button className="icon-button" aria-label={`Restore ${page.title || "Untitled"}`} onClick={() => { useStore.getState().restorePage(page.id); onClose(); navigate(pageUrl(page.id)); }}><RotateCcw size={16} /></button><button className="icon-button danger" aria-label={`Delete permanently ${page.title || "Untitled"}`} onClick={() => { if (confirm("Permanently delete this page?")) useStore.getState().permanentlyDelete(page.id); }}><Trash2 size={16} /></button></div>)}
    {!filtered.length && <div className="empty-state">Trash is empty<button className="action-button" onClick={onClose}>Back to workspace</button></div>}
  </div></Modal>;
}
