"use client";
import { use, useEffect, useState } from "react";
import ReadOnlyPage from "@/components/ReadOnlyPage";
import { fetchPageBundle, fetchPublicPage, type PageBundle } from "@/lib/shares";
export default function PublicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params), [bundle, setBundle] = useState<PageBundle | null>(null), [loading, setLoading] = useState(true), [fallback, setFallback] = useState(false), [copied, setCopied] = useState(false);
  useEffect(() => { let alive = true; void (async () => { const bundle = await fetchPageBundle(id); if (!alive) return; if (bundle) setBundle(bundle); else { const page = await fetchPublicPage(id); if (!alive) return; setFallback(true); setBundle(page ? { page, pages: {}, syncedBlocks: {}, updatedAt: page.updatedAt, truncated: false } : null); } setLoading(false); })(); return () => { alive = false; }; }, [id]);
  return <div className="min-h-screen bg-bg-primary text-text-primary"><header className="flex h-11 items-center justify-between border-b border-border px-4"><span>{bundle?.page.icon} {bundle?.page.title}</span><button onClick={() => { void navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy link"}</button></header><main>{loading ? <p className="empty-state">Loading…</p> : bundle ? <ReadOnlyPage {...bundle} linkBase="/pub" databasesUnavailable={fallback} /> : <p className="empty-state">🔍 This page doesn&apos;t exist or is no longer public.</p>}</main><footer className="flex h-9 items-center justify-center text-xs text-text-tertiary">Made with colabora.si</footer></div>;
}
