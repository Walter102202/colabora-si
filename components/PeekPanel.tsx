import { pageUrl, peekUrl } from "@/lib/routes";
import { useEffect } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router";
import { useStore } from "@/lib/store";
import PageView from "@/components/PageView";
export default function PeekPanel() {
  const [params] = useSearchParams(), location = useLocation();
  const pageId = params.get("peek"), pages = useStore((s) => s.pages), navigate = useNavigate();
  const currentUrl = location.pathname + location.search + location.hash;
  const close = () => { void navigate(peekUrl(null, currentUrl)); };
  useEffect(() => { if (!pageId) return; const key = (event: KeyboardEvent) => { if (event.key === "Escape") void navigate(peekUrl(null, currentUrl)); }; document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key); }, [pageId, navigate, currentUrl]);
  if (!pageId) return null;
  return <div className="peek-overlay"><button className="peek-backdrop" aria-label="Close preview" onClick={close} /><section className="peek-panel" role="dialog" aria-modal="true" aria-label="Page preview"><header><button onClick={() => { close(); navigate(pageUrl(pageId)); }}>Open as page</button><span className="min-w-0 flex-1 truncate">{pages[pageId]?.icon ?? "📄"} {pages[pageId]?.title || "Untitled"}</span><button className="icon-button" aria-label="Close preview panel" onClick={close}>×</button></header><div className="min-h-0 flex-1"><PageView key={pageId} pageId={pageId} /></div></section></div>;
}
