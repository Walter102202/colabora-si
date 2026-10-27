"use client";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getBreadcrumb } from "@/lib/store";
import type { Page } from "@/lib/types";
import { withViewTransition } from "@/lib/viewTransition";
export default function BreadcrumbBlock({ pageId, pages }: { pageId: string; pages: Record<string, Page> }) {
  const router = useRouter(), crumbs = getBreadcrumb(pages, pageId);
  return <div className="my-1 flex flex-wrap items-center text-sm text-text-secondary" contentEditable={false}>{crumbs.length ? crumbs.map((page, i) => <span key={page.id} className="flex items-center">{i > 0 && <ChevronRight size={14} />}<button className="breadcrumb-button max-w-[16em] truncate" onClick={() => withViewTransition(() => router.push(`/p/${page.id}`))}>{page.icon} {page.title || "Untitled"}</button></span>) : "No location"}</div>;
}
