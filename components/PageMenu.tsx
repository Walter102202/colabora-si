"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { downloadMarkdown } from "@/lib/export";
export default function PageMenu({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const page = useStore((s) => s.pages[pageId]), pages = useStore((s) => s.pages), panel = useRef<HTMLDivElement>(null), router = useRouter();
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", key); panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); return () => window.removeEventListener("keydown", key); }, [onClose]);
  if (!page) return null;
  const update = useStore.getState().updatePage, request = (kind: string) => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind, pageId } }));
  return <><button className="menu-backdrop" aria-label="Close page menu" onClick={onClose} /><div ref={panel} className="page-menu menu-panel" role="menu">{([['fullWidth', 'Full width'], ['smallText', 'Small text'], ['locked', 'Lock page']] as const).map(([key, label]) => <button role="menuitem" key={key} aria-pressed={!!page[key]} onClick={() => update(pageId, { [key]: !page[key] })}>{label}<span className={`toggle-switch ${page[key] ? "on" : ""}`} /></button>)}<div className="border-y border-border p-2"><p className="mb-2 text-xs text-text-tertiary">Font style</p><div className="segmented">{(["default", "serif", "mono"] as const).map((font) => <button key={font} className={`font-page-${font}`} aria-pressed={(page.font ?? "default") === font} onClick={() => update(pageId, { font })}>{font[0].toUpperCase() + font.slice(1)}</button>)}</div></div><button role="menuitem" onClick={() => request("history")}>Page history</button><button role="menuitem" onClick={() => request("move")}>Move to…</button><button role="menuitem" onClick={() => { downloadMarkdown(page, pages); onClose(); }}>Export to Markdown</button><button role="menuitem" onClick={() => { void navigator.clipboard.writeText(`${location.origin}/p/${pageId}`); onClose(); }}>Copy link</button><button role="menuitem" className="danger" onClick={() => { useStore.getState().deletePage(pageId); onClose(); router.push("/"); }}>Delete</button></div></>;
}
