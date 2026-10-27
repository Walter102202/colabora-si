"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRight, Menu, MoreHorizontal, Star } from "lucide-react";
import { getBreadcrumb, useStore } from "@/lib/store";
import { initHistory, redo, undo } from "@/lib/history";
import { useHydrated } from "@/lib/useHydrated";
import { withViewTransition } from "@/lib/viewTransition";
import { formatRelative } from "@/lib/utils";
import Sidebar from "@/components/Sidebar";
import Emoji from "@/components/Emoji";
import { PresenceBadge } from "@/components/agents/PresenceBadge";
import { InboxBell } from "@/components/agents/InboxBell";
import SearchModal from "@/components/SearchModal";
import SettingsModal from "@/components/SettingsModal";
import ShortcutsModal from "@/components/ShortcutsModal";
import TrashModal from "@/components/TrashModal";
import MovePageModal from "@/components/MovePageModal";
import PeekPanel from "@/components/PeekPanel";
import TemplateModal from "@/components/TemplateModal";
import AuthModal from "@/components/AuthModal";
import { initAuth, useAuthStore } from "@/lib/auth";
import { initSync, stopSync } from "@/lib/sync";
import SyncConflictModal from "@/components/SyncConflictModal";
import { usePresenceSession, useSharedPresenceScope } from "@/lib/presence";
import PresenceAvatars from "@/components/PresenceAvatars";
import PageMenu from "@/components/PageMenu";
import PageHistoryModal from "@/components/PageHistoryModal";
import { initNotifications, stopNotifications } from "@/lib/notifications";
import { useWorkspaceDirectory } from "@/lib/directory";
import HumanNotifications from "@/components/HumanNotifications";
import ReminderBell from "@/components/ReminderBell";
import SharePopover from "@/components/SharePopover";
import { foreignPageIds } from "@/lib/foreignPages";
import ImportModal from "@/components/ImportModal";

const subscribeWidth = (callback: () => void) => { window.addEventListener("resize", callback); return () => window.removeEventListener("resize", callback); };
export default function Shell({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  return hydrated ? <HydratedShell>{children}</HydratedShell> : <div className="flex h-screen items-center justify-center text-text-tertiary">Loading workspace…</div>;
}
function HydratedShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname(), router = useRouter(), pages = useStore((s) => s.pages);
  const narrow = useSyncExternalStore(subscribeWidth, () => window.innerWidth < 768, () => false);
  const [collapsed, setCollapsed] = useState(false), [drawerAt, setDrawerAt] = useState<string | null>(null);
  const [width, setWidth] = useState(() => { try { const value = Number(localStorage.getItem("colabora-sidebar-width")); return value > 0 ? Math.max(200, Math.min(480, value)) : 260; } catch { return 260; } });
  const [resizing, setResizing] = useState(false);
  const [modal, setModal] = useState<{ kind: string; pageId?: string } | null>(null);
  const pageId = /^\/p\/([^/]+)/.exec(pathname)?.[1], page = pageId ? pages[pageId] : undefined;
  const user = useAuthStore((s) => s.user), workspaceId = useStore((s) => s.syncWorkspaceId);
  const sharedId = /^\/shared\/([^/]+)/.exec(pathname)?.[1], sharedWorkspace = useSharedPresenceScope((s) => sharedId ? s.byPage[sharedId] : undefined);
  usePresenceSession(pageId ?? sharedId ?? null, pageId ? workspaceId : sharedWorkspace ?? null, user?.id ?? null, user?.email ?? "", user?.user_metadata.full_name);
  useWorkspaceDirectory();
  useEffect(() => { if (user) initNotifications(user.id); else stopNotifications(); return stopNotifications; }, [user]);
  const crumbs = pageId ? getBreadcrumb(pages, pageId) : [];
  const request = (kind: string, pageId?: string) => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind, pageId } }));
  useEffect(() => { initHistory(); initAuth(); }, []);
  useEffect(() => {
    let currentId: string | null = null;
    const update = () => { const user = useAuthStore.getState().user; if ((user?.id ?? null) === currentId) return; currentId = user?.id ?? null; if (user) void initSync(user); else stopSync(); };
    update(); const unsubscribe = useAuthStore.subscribe(update);
    return () => { unsubscribe(); stopSync(); };
  }, []);
  useEffect(() => {
    const handler = (event: Event) => setModal((event as CustomEvent<{ kind: string; pageId?: string }>).detail);
    window.addEventListener("colabora-modal", handler);
    return () => window.removeEventListener("colabora-modal", handler);
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey, key = event.key.toLowerCase(), target = event.target as HTMLElement;
      if (mod && (key === "p" || key === "k")) { event.preventDefault(); request("search"); }
      else if (mod && key === "\\") { event.preventDefault(); setCollapsed((value) => !value); setDrawerAt((value) => value === pathname ? null : pathname); }
      else if (mod && key === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (mod && key === "y") { event.preventDefault(); redo(); }
      else if ((mod && key === "/") || (key === "?" && !target.isContentEditable && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) { event.preventDefault(); request("shortcuts"); }
      else if (key === "escape") setDrawerAt(null);
      if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key) && target.closest('[role="menu"]')) {
        const menu = target.closest('[role="menu"]')!, items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const current = items.indexOf(target as HTMLButtonElement); items[(current + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus(); }
        if (event.key === "Escape") { event.preventDefault(); (menu.previousElementSibling as HTMLButtonElement | null)?.click(); }
      }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, [pathname]);
  return <div className={`app-shell flex h-screen overflow-hidden ${resizing ? "select-none" : ""}`}>
    {narrow && drawerAt === pathname && <button className="drawer-backdrop" aria-label="Close sidebar" onClick={() => setDrawerAt(null)} />}
    <div className={`app-sidebar ${narrow ? "drawer" : ""} ${narrow && drawerAt !== pathname ? "drawer-closed" : ""}`} style={{ width: narrow ? 256 : collapsed ? 0 : width, transitionDuration: resizing ? "0ms" : undefined }}>
      <Sidebar collapse={() => { setCollapsed(true); setDrawerAt(null); }} />
      {!narrow && !collapsed && <div role="separator" aria-label="Resize sidebar" aria-orientation="vertical" tabIndex={0} className="sidebar-resizer" onDoubleClick={() => { setWidth(260); localStorage.setItem("colabora-sidebar-width", "260"); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { const next = Math.min(480, Math.max(200, width + (event.key === "ArrowRight" ? 10 : -10))); setWidth(next); localStorage.setItem("colabora-sidebar-width", String(next)); } }} onPointerDown={(event) => {
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setResizing(true);
      }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(200, Math.min(480, event.clientX))); }} onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); setResizing(false); localStorage.setItem("colabora-sidebar-width", String(width)); }} onPointerCancel={() => setResizing(false)} />}
    </div>
    <div className="app-main flex min-w-0 flex-1 flex-col"><header className="app-topbar flex h-11 shrink-0 items-center gap-1 px-3">
      {(collapsed || narrow) && <button className="icon-button" aria-label="Open sidebar" onClick={() => { setCollapsed(false); setDrawerAt(pathname); }}><Menu size={18} /></button>}
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center text-sm">{crumbs.length ? crumbs.map((crumb, index) => <span className="flex min-w-0 items-center" key={crumb.id}>{index > 0 && <ChevronRight size={14} className="shrink-0 text-text-tertiary" />}<button className="breadcrumb-button" onClick={() => withViewTransition(() => router.push(`/p/${crumb.id}`))}><Emoji emoji={crumb.icon ?? "📄"} size={16} /><span className="truncate">{crumb.title || "Untitled"}</span></button></span>) : <button className="text-text-tertiary" onClick={() => request("search")}>Search…</button>}</nav>
      {page && <><span className="hidden whitespace-nowrap text-xs text-text-tertiary md:block">Edited {formatRelative(page.updatedAt)}</span><PresenceAvatars /><PresenceBadge pageId={page.id} /></>}
      {user && <HumanNotifications />}<ReminderBell /><InboxBell />
      {page && user && workspaceId && !foreignPageIds.has(page.id) && <button className="action-button" title="Share or publish to the web" onClick={() => request("share", page.id)}>Share</button>}
      {page && <><button className={`icon-button ${page.isFavorite ? "favorite-star" : ""}`} aria-label={page.isFavorite ? "Remove from Favorites" : "Add to Favorites"} onClick={() => useStore.getState().toggleFavorite(page.id)}><Star size={17} fill={page.isFavorite ? "currentColor" : "none"} /></button><button className="icon-button" aria-label="Style, export, and more" onClick={() => request("page-menu", page.id)}><MoreHorizontal size={18} /></button></>}
    </header><main className="min-h-0 flex-1">{children}</main></div>
    {modal?.kind === "search" && <SearchModal onClose={() => setModal(null)} />}
    {modal?.kind === "settings" && <SettingsModal onClose={() => setModal(null)} />}
    {modal?.kind === "auth" && <AuthModal onClose={() => setModal(null)} />}
    {modal?.kind === "shortcuts" && <ShortcutsModal onClose={() => setModal(null)} />}
    {modal?.kind === "trash" && <TrashModal onClose={() => setModal(null)} />}
    {modal?.kind === "move" && modal.pageId && <MovePageModal pageId={modal.pageId} onClose={() => setModal(null)} />}
    {modal?.kind === "page-menu" && modal.pageId && <PageMenu pageId={modal.pageId} onClose={() => setModal(null)} />}
    {modal?.kind === "history" && modal.pageId && <PageHistoryModal pageId={modal.pageId} onClose={() => setModal(null)} />}
    {modal?.kind === "import" && <ImportModal onClose={() => setModal(null)} />}
    <PeekPanel />
    <SyncConflictModal />
    {modal?.kind === "share" && modal.pageId && <SharePopover pageId={modal.pageId} onClose={() => setModal(null)} />}
    {modal?.kind === "template" && <TemplateModal pageId={modal.pageId} onClose={() => setModal(null)} />}
  </div>;
}
