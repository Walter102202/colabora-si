import { pageUrl } from "@/lib/routes";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useStore } from "@/lib/store";
import { downloadHtml, downloadMarkdown, exportPagePdf } from "@/lib/export";
import { ensurePageBody, ensurePageBodies, exportDeps, notifyPageUnavailable } from "@/lib/pageBodies";
import type { Page } from "@/lib/types";
export default function PageMenu({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const page = useStore((s) => s.pages[pageId]), panel = useRef<HTMLDivElement>(null), navigate = useNavigate();
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", key); panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); return () => window.removeEventListener("keydown", key); }, [onClose]);
  if (!page) return null;
  const update = useStore.getState().updatePage, request = (kind: string) => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind, pageId } }));
  const exportPage = async (run: (pages: Record<string, Page>) => void | Promise<void>) => {
    if (await ensurePageBody(pageId) !== "ready" || await ensurePageBodies(exportDeps(pageId, useStore.getState().pages)) !== "ready") { notifyPageUnavailable(); return; }
    await run(useStore.getState().pages); onClose();
  };
  return <><button className="menu-backdrop" aria-label="Close page menu" onClick={onClose} /><div ref={panel} className="page-menu menu-panel" role="menu">{([['fullWidth', 'Full width'], ['smallText', 'Small text'], ['locked', 'Lock page']] as const).map(([key, label]) => <button role="menuitemcheckbox" key={key} aria-checked={!!page[key]} onClick={() => update(pageId, { [key]: !page[key] })}>{label}<span className={`toggle-switch ${page[key] ? "on" : ""}`} /></button>)}<div className="border-y border-border p-2"><p className="mb-2 text-xs text-text-tertiary">Font style</p><div className="segmented">{(["default", "serif", "mono"] as const).map((font) => <button key={font} className={`font-page-${font}`} aria-pressed={(page.font ?? "default") === font} onClick={() => update(pageId, { font })}>{font[0].toUpperCase() + font.slice(1)}</button>)}</div></div><button role="menuitem" onClick={() => request("history")}>Page history</button><button role="menuitem" onClick={() => request("move")}>Move to…</button><button role="menuitem" onClick={() => { void exportPage((pages) => downloadMarkdown(pages[pageId], pages)); }}>Export to Markdown</button><button role="menuitem" onClick={() => { void exportPage((pages) => downloadHtml(pages[pageId], pages, useStore.getState().syncedBlocks ?? {})); }}>Export to HTML</button><button role="menuitem" onClick={() => { void exportPage(() => exportPagePdf()); }}>Export as PDF</button><button role="menuitem" onClick={() => { void navigator.clipboard.writeText(location.origin + pageUrl(pageId)); onClose(); }}>Copy link</button><button role="menuitem" className="danger" onClick={() => { useStore.getState().deletePage(pageId); onClose(); navigate("/"); }}>Delete</button></div></>;
}
