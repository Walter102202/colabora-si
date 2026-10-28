import { pageUrl, pubUrl, sharedUrl } from "@/lib/routes";
import { useNavigate } from "react-router";
import { ChevronRight } from "lucide-react";
import { getBreadcrumb } from "@/lib/store";
import type { Page } from "@/lib/types";
import { withViewTransition } from "@/lib/viewTransition";
import { useReadOnlyData } from "@/lib/readOnlyData";
export default function BreadcrumbBlock({ pageId, pages }: { pageId: string; pages: Record<string, Page> }) {
  const navigate = useNavigate(), readOnly = useReadOnlyData(), crumbs = getBreadcrumb(pages, pageId);
  return <div className="my-1 flex flex-wrap items-center text-sm text-text-secondary" contentEditable={false}>{crumbs.length ? crumbs.map((page, i) => <span key={page.id} className="flex items-center">{i > 0 && <ChevronRight size={14} />}<button className="breadcrumb-button max-w-[16em] truncate" disabled={!!readOnly && !readOnly.linkBase} onClick={() => withViewTransition(() => navigate(readOnly?.linkBase === "/pub" ? pubUrl(page.id) : readOnly?.linkBase === "/shared" ? sharedUrl(page.id) : pageUrl(page.id)))}>{page.icon} {page.title || "Untitled"}</button></span>) : "No location"}</div>;
}
