import { useId, useState } from "react";
import type { DiscrepancyResolution, DiscrepancyRow } from "@/lib/agentSources";

// A page and one of its sources disagree. Nothing changes until a person says which one stands.
export function DiscrepancyCard({ discrepancy, pageTitle, href, onResolve }: {
  discrepancy: DiscrepancyRow;
  pageTitle?: string;
  href?: string;
  onResolve: (resolution: DiscrepancyResolution, note: string) => Promise<void>;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (resolution: DiscrepancyResolution) => {
    setBusy(true);
    setError(null);
    try {
      await onResolve(resolution, note.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
      {pageTitle && (href ? <a href={href} className="font-medium hover:underline">{pageTitle}</a> : <p className="font-medium">{pageTitle}</p>)}
      <p>{discrepancy.summary}</p>
      {discrepancy.items.length > 0 && (
        <ul className="space-y-1 text-xs text-text-secondary">
          {discrepancy.items.map((item, i) => (
            <li key={`${item.source_id}:${i}`}>The source says “{item.source_says}”. The page says “{item.page_says}”.</li>
          ))}
        </ul>
      )}
      <div className="space-y-1">
        <label htmlFor={`${id}-note`} className="text-xs text-text-secondary">Note (optional)</label>
        <input id={`${id}-note`} className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" maxLength={500} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" disabled={busy} onClick={() => void resolve("update")}>Update the page</button>
        <button type="button" className="rounded border border-border px-3 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50" disabled={busy} onClick={() => void resolve("keep")}>Keep it as it is</button>
      </div>
    </div>
  );
}
