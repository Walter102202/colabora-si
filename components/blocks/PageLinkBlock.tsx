"use client";
import { useRouter } from "next/navigation";
import type { Page } from "@/lib/types";
import { withViewTransition } from "@/lib/viewTransition";
import { useReadOnlyData } from "@/lib/readOnlyData";
export default function PageLinkBlock({ page }: { page?: Page }) {
  const router = useRouter(), readOnly = useReadOnlyData();
  return page ? <button className="page-link-block" disabled={!!readOnly && !readOnly.linkBase} onClick={() => withViewTransition(() => router.push(`${readOnly?.linkBase ?? "/p"}/${page.id}`))}><span>{page.icon ?? "📄"}</span><span className="border-b border-border font-medium">{page.title || "Untitled"}</span></button> : <span className="text-text-tertiary">Empty page</span>;
}
