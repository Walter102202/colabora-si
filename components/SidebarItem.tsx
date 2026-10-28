import { Input } from "@/components/FormControls";
import { pageUrl } from "@/lib/routes";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ChevronRight, Copy, FileText, MoreHorizontal, Plus, Star, Trash2 } from "lucide-react";
import { getChildren, useStore } from "@/lib/store";
import { withViewTransition } from "@/lib/viewTransition";
import Emoji from "@/components/Emoji";

export default function SidebarItem({ pageId, depth = 0 }: { pageId: string; depth?: number }) {
  const pages = useStore((s) => s.pages), expanded = useStore((s) => s.expanded[pageId] ?? false);
  const navigate = useNavigate(), pathname = useLocation().pathname;
  const [menu, setMenu] = useState(false), [renaming, setRenaming] = useState(false), [dragOver, setDragOver] = useState(false);
  const page = pages[pageId];
  if (!page || page.isDeleted || depth > 100) return null;
  const children = getChildren(pages, pageId), active = pathname === pageUrl(pageId);
  const open = (id: string) => withViewTransition(() => navigate(pageUrl(id)));
  const action = (fn: () => void) => { setMenu(false); fn(); };
  return <div className="relative">
    <div role="presentation" aria-label={page.title || "Untitled"} className={`sidebar-row group ${active ? "active" : ""} ${dragOver ? "drop-target" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} draggable={!renaming}
      onDragStart={(event) => { event.dataTransfer.setData("text/page-id", pageId); event.stopPropagation(); }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("text/page-id")) { event.preventDefault(); event.stopPropagation(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDragOver(false); const id = event.dataTransfer.getData("text/page-id"); if (id && id !== pageId) useStore.getState().movePage(id, pageId); }}>
      <button className="tree-toggle icon-button" aria-label={`${expanded ? "Collapse" : "Expand"} ${page.title || "Untitled"}`} onClick={() => useStore.getState().setExpanded(pageId, !expanded)}>
        <span className="tree-icon">{page.icon ? <Emoji emoji={page.icon} /> : <FileText size={16} />}</span>
        <ChevronRight className={`tree-chevron ${expanded ? "rotate-90" : ""}`} size={14} />
      </button>
      {renaming ? <Input label="Page name" focusOnMount aria-label="Page name" className="min-w-0 flex-1" defaultValue={page.title} onBlur={(event) => { useStore.getState().updatePage(pageId, { title: event.target.value }); setRenaming(false); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setRenaming(false); }} /> : <button className="min-w-0 flex-1 truncate text-left" onClick={() => open(pageId)} onDoubleClick={() => setRenaming(true)}>{page.title || "Untitled"}</button>}
      <div className="hover-actions flex"><button className="icon-button" aria-label={`Actions for ${page.title || "Untitled"}`} onClick={() => setMenu(!menu)}><MoreHorizontal size={15} /></button><button className="icon-button" aria-label={`Add a page inside ${page.title || "Untitled"}`} onClick={() => open(useStore.getState().createPage(pageId))}><Plus size={15} /></button></div>
    </div>
    {menu && <><button className="menu-backdrop" aria-label="Close page actions" onClick={() => setMenu(false)} /><div className="menu-panel absolute left-8 top-7 w-52" role="menu">
      <button role="menuitem" onClick={() => action(() => useStore.getState().toggleFavorite(pageId))}><Star size={15} />{page.isFavorite ? "Remove from Favorites" : "Add to Favorites"}</button>
      <button role="menuitem" onClick={() => action(() => setRenaming(true))}>Rename</button>
      <button role="menuitem" onClick={() => action(() => { const id = useStore.getState().duplicatePage(pageId); if (id) open(id); })}><Copy size={15} />Duplicate</button>
      <button role="menuitem" onClick={() => action(() => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind: "move", pageId } })))}>Move to…</button>
      <button role="menuitem" onClick={() => action(() => { void navigator.clipboard.writeText(location.origin + pageUrl(pageId)); })}>Copy link</button>
      <button role="menuitem" className="danger" onClick={() => action(() => { useStore.getState().deletePage(pageId); if (active) navigate("/"); })}><Trash2 size={15} />Delete</button>
    </div></>}
    {expanded && (children.length ? children.map((child) => <SidebarItem key={child.id} pageId={child.id} depth={depth + 1} />) : <div className="py-1 text-xs text-text-tertiary" style={{ paddingLeft: 8 + (depth + 1) * 14 + 28 }}>No pages inside</div>)}
  </div>;
}
