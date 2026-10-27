"use client";
import { useRouter } from "next/navigation";
import type { Page } from "@/lib/types";
import { withViewTransition } from "@/lib/viewTransition";
export default function PageLinkBlock({ page }: { page?: Page }) {
  const router = useRouter();
  return page ? <button className="page-link-block" onClick={() => withViewTransition(() => router.push(`/p/${page.id}`))}><span>{page.icon ?? "📄"}</span><span className="border-b border-border font-medium">{page.title || "Untitled"}</span></button> : <span className="text-text-tertiary">Empty page</span>;
}
