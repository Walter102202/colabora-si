import { pageUrl, sharedUrl } from "@/lib/routes";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronsLeft, ChevronDown, Home, Moon, Plus, Search, Settings, Star, Sun, Trash2 } from "lucide-react";
import { getFavorites, useStore } from "@/lib/store";
import { useTheme } from "@/lib/useTheme";
import { withViewTransition } from "@/lib/viewTransition";
import Emoji from "@/components/Emoji";
import SidebarItem from "@/components/SidebarItem";
import SyncStatus from "@/components/SyncStatus";
import Tooltip from "@/components/Tooltip";
import { useAuth } from "@/lib/auth";

import { useDirectory } from "@/lib/directory";
import { clearSharedWithMe, refreshSharedWithMe, useShares } from "@/lib/shares";
export default function Sidebar({ collapse }: { collapse: () => void }) {
  const pages = useStore((s) => s.pages), rootOrder = useStore((s) => s.rootOrder), navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const { user } = useAuth(), shares = useShares((s) => s.entries);
  useEffect(() => { if (!user) { clearSharedWithMe(); return; } void refreshSharedWithMe(); const refresh = () => void refreshSharedWithMe(); window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, [user]);
  const [workspaceMenu, setWorkspaceMenu] = useState(false), [addMenu, setAddMenu] = useState(false);
  const openModal = (kind: string) => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind } }));
  const open = (id: string) => { setAddMenu(false); withViewTransition(() => navigate(pageUrl(id))); };
  const favorites = getFavorites(pages), workspaceName = useDirectory((s) => s.workspaceName);
  return <aside className="sidebar-inner group/aside">
    <div className="relative flex items-center justify-between px-3 pb-1 pt-2.5">
      <button className="workspace-chip" onClick={() => setWorkspaceMenu(!workspaceMenu)}><span className="workspace-avatar">C</span><span className="truncate">{user ? workspaceName : "My Workspace"}</span><ChevronDown size={14} /></button>
      <Tooltip label="Collapse sidebar" shortcut="Ctrl+\"><button className="icon-button hover-actions" aria-label="Collapse sidebar" onClick={collapse}><ChevronsLeft size={17} /></button></Tooltip>
      {workspaceMenu && <><button className="menu-backdrop" aria-label="Close workspace menu" onClick={() => setWorkspaceMenu(false)} /><div className="menu-panel absolute left-3 top-12 w-56" role="menu">
        <button role="menuitem" onClick={toggle}>{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}{theme === "dark" ? "Light mode" : "Dark mode"}</button>
        <button role="menuitem" className="danger" onClick={() => { if (confirm("Reset the entire workspace? This deletes all pages on this device.")) { useStore.getState().resetWorkspace(); setWorkspaceMenu(false); navigate("/"); } }}>Reset workspace</button>
      </div></>}
    </div>
    <div className="flex items-center gap-1 px-3 pb-2 pt-1.5">
      <button className="home-pill" onClick={() => withViewTransition(() => navigate("/"))}><Home size={15} />Home</button>
      <Tooltip label="Settings"><button className="icon-button rounded-full" aria-label="Settings" onClick={() => openModal("settings")}><Settings size={17} /></button></Tooltip>
      <span className="flex-1" /><Tooltip label="Search pages" shortcut="Ctrl+K"><button className="icon-button" aria-label="Search pages" onClick={() => openModal("search")}><Search size={17} /></button></Tooltip>
    </div>
    <div className="scrollbar-thin mt-2 min-h-0 flex-1 overflow-y-auto px-2">
      {favorites.length > 0 && <section className="mb-5"><div className="section-label">Favorites</div>{favorites.map((page) => <button key={page.id} className="sidebar-row w-full px-2" onClick={() => open(page.id)}><Emoji emoji={page.icon ?? "📄"} /><Star size={13} className="favorite-star" /><span className="truncate">{page.title || "Untitled"}</span></button>)}</section>}
      {user && !!shares.length && <section className="mb-5"><div className="section-label">Shared</div>{shares.map((share) => <button key={share.pageId} className="sidebar-row w-full px-2" onClick={() => withViewTransition(() => navigate(sharedUrl(share.pageId)))}><Emoji emoji={share.icon ?? "📄"} /><span className="min-w-0 flex-1 truncate">{share.title || "Untitled"}</span><span className="text-[10px] uppercase text-text-tertiary">{share.level}</span></button>)}</section>}
      <div role="presentation" aria-label="Private pages" className="relative flex items-center justify-between" onDragOver={(event) => { if (event.dataTransfer.types.includes("text/page-id")) event.preventDefault(); }} onDrop={(event) => { const id = event.dataTransfer.getData("text/page-id"); if (id) { event.preventDefault(); useStore.getState().movePage(id, null); } }}>
        <div className="section-label">Private</div><button className="icon-button hover-actions" aria-label="Add a page" onClick={() => setAddMenu(!addMenu)}><Plus size={15} /></button>
        {addMenu && <><button className="menu-backdrop" aria-label="Close add page menu" onClick={() => setAddMenu(false)} /><div className="menu-panel absolute right-1 top-7 w-52" role="menu">
          <button role="menuitem" onClick={() => open(useStore.getState().createPage())}>New page</button><button role="menuitem" onClick={() => open(useStore.getState().createDatabasePage())}>New database</button>
          <button role="menuitem" onClick={() => { setAddMenu(false); openModal("template"); }}>From a template</button><button role="menuitem" onClick={() => { setAddMenu(false); openModal("import"); }}>Import Markdown</button>
        </div></>}
      </div>
      {rootOrder.filter((id) => pages[id] && !pages[id].isDeleted).map((id) => <SidebarItem key={id} pageId={id} />)}
      {!rootOrder.some((id) => pages[id] && !pages[id].isDeleted) && <div className="empty-state text-xs">No pages yet<button onClick={() => open(useStore.getState().createPage())}>New page</button></div>}
    </div>
    <div className="border-t border-border px-2 py-2"><div className="px-2 py-2"><SyncStatus /></div><button className="sidebar-row w-full px-2" onClick={() => openModal("auth")}><span className="workspace-avatar h-5 w-5 text-xs">{user ? (user.email ?? "U")[0].toUpperCase() : "C"}</span><span className="truncate">{user?.email ?? "Log in"}</span></button><button className="sidebar-row w-full px-2" onClick={() => openModal("trash")}><Trash2 size={16} />Trash</button></div>
  </aside>;
}
