import { pageUrl } from "@/lib/routes";
import { useNavigate } from "react-router";
import { Database, Plus } from "lucide-react";
import { useStore } from "@/lib/store";
import { formatRelative } from "@/lib/utils";
import { withViewTransition } from "@/lib/viewTransition";
import Emoji from "@/components/Emoji";
import { DecisionsHome } from "@/components/agents/DecisionsHome";

export default function Home() {
  const pages = useStore((s) => s.pages), navigate = useNavigate();
  const recent = Object.values(pages).filter((p) => !p.isDeleted).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  const hour = new Date().getHours();
  const open = (id: string) => withViewTransition(() => navigate(pageUrl(id)));
  return <div className="h-full overflow-y-auto scrollbar-thin"><div className="mx-auto max-w-4xl px-8 py-14">
    <title>Home · colabora.si</title><h1 className="mb-8 text-3xl font-bold">{hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}</h1>
    <div className="mb-12 flex gap-2">
      <button className="action-button" onClick={() => open(useStore.getState().createPage())}><Plus size={16} />New page</button>
      <button className="action-button" onClick={() => open(useStore.getState().createDatabasePage())}><Database size={16} />New database</button>
    </div>
    <DecisionsHome />
    <h2 className="mb-3 text-xs text-text-tertiary">Recently edited</h2>
    {recent.length ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{recent.map((page) => <button className="home-card" key={page.id} onClick={() => open(page.id)}>
      <div className="h-11 bg-bg-secondary" /><div className="px-3 pb-3"><div className="-mt-4 mb-3"><Emoji emoji={page.icon ?? "📄"} size={28} /></div><div className="truncate text-sm font-medium">{page.title || "Untitled"}</div><div className="mt-1 text-xs text-text-tertiary">{formatRelative(page.updatedAt)}</div></div>
    </button>)}</div> : <div className="empty-state">No pages yet. Create your first page to get started.<button className="action-button" onClick={() => open(useStore.getState().createPage())}>New page</button></div>}
  </div></div>;
}
