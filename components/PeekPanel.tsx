"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePeek } from "@/lib/peek";
import { useStore } from "@/lib/store";
import { withViewTransition } from "@/lib/viewTransition";
import PageView from "@/components/PageView";
export default function PeekPanel() {
  const pageId = usePeek((s) => s.pageId), pages = useStore((s) => s.pages), router = useRouter();
  const close = () => withViewTransition(() => usePeek.getState().close());
  useEffect(() => { if (!pageId) return; const key = (event: KeyboardEvent) => { if (event.key === "Escape") withViewTransition(() => usePeek.getState().close()); }; document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key); }, [pageId]);
  if (!pageId) return null;
  return <div className="peek-overlay"><button className="peek-backdrop" aria-label="Close preview" onClick={close} /><section className="peek-panel" role="dialog" aria-modal="true" aria-label="Page preview"><header><button onClick={() => { close(); router.push(`/p/${pageId}`); }}>Open as page</button><span className="min-w-0 flex-1 truncate">{pages[pageId]?.icon ?? "📄"} {pages[pageId]?.title || "Untitled"}</span><button className="icon-button" aria-label="Close preview panel" onClick={close}>×</button></header><div className="min-h-0 flex-1"><PageView key={pageId} pageId={pageId} /></div></section></div>;
}
