import { pageUrl, pubUrl, sharedUrl } from "@/lib/routes";
import { useNavigate } from "react-router";
import type { Page } from "@/lib/types";
import { withViewTransition } from "@/lib/viewTransition";
import { useReadOnlyData } from "@/lib/readOnlyData";
export default function PageLinkBlock({ page }: { page?: Page }) {
  const navigate = useNavigate(), readOnly = useReadOnlyData();
  return page ? <button className="page-link-block" disabled={!!readOnly && !readOnly.linkBase} onClick={() => withViewTransition(() => navigate(readOnly?.linkBase === "/pub" ? pubUrl(page.id) : readOnly?.linkBase === "/shared" ? sharedUrl(page.id) : pageUrl(page.id)))}><span>{page.icon ?? "📄"}</span><span className="border-b border-border font-medium">{page.title || "Untitled"}</span></button> : <span className="text-text-tertiary">Empty page</span>;
}
