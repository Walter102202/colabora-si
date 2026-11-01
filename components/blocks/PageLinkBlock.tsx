import { pageUrl, pubUrl, sharedUrl } from "@/lib/routes";
import type { DragEventHandler } from "react";
import { useNavigate } from "react-router";
import type { Page } from "@/lib/types";
import { withViewTransition } from "@/lib/viewTransition";
import { useReadOnlyData } from "@/lib/readOnlyData";
export default function PageLinkBlock({ page, onDragStart, onDragEnd }: { page?: Page; onDragStart?: DragEventHandler<HTMLButtonElement>; onDragEnd?: DragEventHandler<HTMLButtonElement> }) {
  const navigate = useNavigate(), readOnly = useReadOnlyData();
  return page ? <button className="page-link-block" draggable={!!onDragStart && !readOnly} onDragStart={readOnly ? undefined : onDragStart} onDragEnd={onDragEnd} title={onDragStart && !readOnly ? "Drag to move · Click to open" : undefined} disabled={!!readOnly && !readOnly.linkBase} onClick={(event) => { if (event.shiftKey) { event.preventDefault(); return; } withViewTransition(() => navigate(readOnly?.linkBase === "/pub" ? pubUrl(page.id) : readOnly?.linkBase === "/shared" ? sharedUrl(page.id) : pageUrl(page.id))); }}><span>{page.icon ?? "📄"}</span><span className="border-b border-border font-medium">{page.title || "Untitled"}</span></button> : <span className="text-text-tertiary">Empty page</span>;
}
