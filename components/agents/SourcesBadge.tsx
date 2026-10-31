import { useEffect, useMemo, useState } from "react";
import { DiscrepancyCard } from "@/components/agents/panel/DiscrepancyCard";
import { getAgentClient } from "@/lib/agentClient";
import { declareSources, openDiscrepancies, parseSourceInput, removeSource, resolveDiscrepancy, sourcesOfPage, useAgentSources, type PageSourceRow } from "@/lib/agentSources";
import { useStore } from "@/lib/store";
import { formatRelative } from "@/lib/utils";

const STATUS: Record<PageSourceRow["status"], string> = { current: "Up to date", changed: "Changed", discrepancy: "Differs" };

// What this page was built from. PresenceBadge mounts it in the topbar of every page.
export function SourcesBadge({ pageId }: { pageId: string }) {
  const workspaceId = useStore((s) => s.syncWorkspaceId);
  const pages = useStore((s) => s.pages);
  const allSources = useAgentSources((s) => s.sources);
  const allOpen = useAgentSources((s) => s.discrepancies);
  const subscribe = useAgentSources((s) => s.subscribe);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = !!getAgentClient() && !!workspaceId;
  useEffect(() => (active && workspaceId ? subscribe(workspaceId) : undefined), [active, subscribe, workspaceId]);
  const sources = useMemo(() => sourcesOfPage(allSources, pageId), [allSources, pageId]);
  const discrepancy = useMemo(() => openDiscrepancies(allOpen).find((d) => d.page_id === pageId), [allOpen, pageId]);
  if (!active) return null;

  const moved = sources.filter((s) => s.status !== "current").length;
  const add = async () => {
    const source = parseSourceInput(link, window.location.origin);
    if (!source) { setError("Paste a page link or a web address."); return; }
    setError(null);
    try {
      await declareSources(pageId, [source]);
      setLink("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <details className="relative hidden md:block">
      <summary className={`cursor-pointer list-none whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs ${moved ? "text-accent" : "text-text-tertiary"}`}>
        {moved ? `${moved} source${moved === 1 ? "" : "s"} changed` : `Sources (${sources.length})`}
      </summary>
      <div className="absolute right-0 z-50 mt-1 w-80 space-y-2 rounded-md border border-border bg-bg p-3 text-sm shadow-lg">
        {discrepancy && <DiscrepancyCard discrepancy={discrepancy} onResolve={async (resolution, note) => { await resolveDiscrepancy(discrepancy.id, resolution, note); }} />}
        {sources.length === 0 && <p className="text-xs text-text-tertiary">No sources declared for this page.</p>}
        <ul className="space-y-1">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate" title={`Observed ${formatRelative(Date.parse(s.observed_at))}`}>
                {s.url ?? (pages[s.source_page_id ?? ""]?.title || "Untitled")}
              </span>
              <span className="shrink-0 text-text-tertiary">{STATUS[s.status]}</span>
              <button type="button" aria-label="Remove this source" className="shrink-0 text-text-tertiary hover:text-text" onClick={() => void removeSource(s.id).catch((e) => setError(String(e?.message ?? e)))}>×</button>
            </li>
          ))}
        </ul>
        <div className="flex gap-1">
          <input aria-label="Page link or web address" className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs" placeholder="Page link or web address" value={link} onChange={(e) => setLink(e.target.value)} />
          <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" disabled={!link.trim()} onClick={() => void add()}>Add</button>
        </div>
        {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      </div>
    </details>
  );
}
