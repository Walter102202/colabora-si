import { useMemo, useRef, useState } from "react";
import { isRunActive, itemLabel, revertableKeys, statusLabel, wordDiff, type DiffItem, type RunDiff, type TaskDiff } from "@/lib/agentRunDiff";

type Revert = (runId: string, keys: string[]) => Promise<void>;

function ItemText({ item }: { item: DiffItem }) {
  // The word diff is quadratic in the number of words: compute it once per pair of texts.
  const parts = useMemo(() => item.before_text === null ? null : wordDiff(item.before_text, item.after_text ?? ""), [item.before_text, item.after_text]);
  // Once a person edited the block (or it can only be reverted by hand), its current text is no longer the run's.
  const now = item.status === "revertable" ? "After" : "Now";
  return <>
    {item.before_text && parts && <p>Before: {parts.filter((p) => p.op !== "add").map((p, i) => <span key={i}>{i > 0 && " "}{p.op === "del" ? <del className="bg-red-500/10">{p.text}</del> : p.text}</span>)}</p>}
    {item.after_text && <p>{now}: {parts ? parts.filter((p) => p.op !== "del").map((p, i) => <span key={i}>{i > 0 && " "}{p.op === "add" ? <ins className="bg-green-500/10">{p.text}</ins> : p.text}</span>) : item.after_text}</p>}
  </>;
}

function RunChanges({ run, onRevert }: { run: RunDiff; onRevert?: Revert }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const active = isRunActive(run);
  const canRevert = !!onRevert && !active;
  const revertable = revertableKeys(run);
  const keys = revertable.filter((key) => selected.includes(key));
  // A reload after a failed revert can leave nothing selected: then the confirmation has nothing to ask about.
  const asking = confirming && keys.length > 0;
  const revert = async () => {
    if (!onRevert || !keys.length || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      await onRevert(run.run_id, keys);
      setSelected([]); setConfirming(false);
      // The confirmation row goes away; keep the focus inside this run.
      heading.current?.focus();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return (
    <div className="space-y-2">
      <h5 ref={heading} tabIndex={-1} className="text-xs font-medium focus:outline-none">Changes by {run.harness}</h5>
      <ul className="space-y-2 text-xs">
        {run.items.map((item) => (
          <li key={item.key} className="space-y-1 rounded border border-border p-2">
            {canRevert && item.status === "revertable" ? (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={keys.includes(item.key)} disabled={busy} onChange={(e) => {
                  // A confirmation left behind by a reload that emptied the selection does not come back by itself.
                  if (!asking) setConfirming(false);
                  setSelected((prev) => e.target.checked ? [...prev, item.key] : prev.filter((key) => key !== item.key));
                }} />
                {itemLabel(item)}
              </label>
            ) : <p>{itemLabel(item)}</p>}
            <p className="text-text-secondary">{statusLabel(item.status)}</p>
            <ItemText item={item} />
          </li>
        ))}
      </ul>
      {onRevert && active && <p className="text-xs text-text-secondary">This run is still active; stop it to revert its changes.</p>}
      {canRevert && !revertable.length && <p className="text-xs text-text-secondary">None of these changes can be reverted automatically.</p>}
      {canRevert && revertable.length > 0 && !asking && <button type="button" className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50" disabled={!keys.length || busy} onClick={() => setConfirming(true)}>Revert selected</button>}
      {canRevert && asking && <div className="flex items-center gap-2 text-xs">
        <span>Revert {keys.length} {keys.length === 1 ? "change" : "changes"}?</span>
        <button type="button" className="rounded bg-accent px-3 py-1 text-white disabled:opacity-50" disabled={busy || !keys.length} onClick={() => void revert()}>Confirm</button>
        <button type="button" className="rounded border border-border px-3 py-1 disabled:opacity-50" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
      </div>}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}

export function RunDiffCard({ diff, onRevert, onRefresh }: { diff: TaskDiff; onRevert?: Revert; onRefresh?: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  // The warning belongs to the diff it could not replace: any later load hides it.
  const [failedOn, setFailedOn] = useState<TaskDiff | null>(null);
  const refresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true); setFailedOn(null);
    // The diff on screen stays until a load succeeds.
    try { await onRefresh(); } catch { setFailedOn(diff); } finally { setRefreshing(false); }
  };
  return <div className="space-y-3">
    {onRefresh && <div className="flex justify-end">
      <button type="button" className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-bg-secondary disabled:opacity-50" disabled={refreshing} onClick={() => void refresh()}>Refresh</button>
    </div>}
    {failedOn === diff && <p role="alert" className="text-xs text-red-700 dark:text-red-400">Could not refresh the changes. Try again.</p>}
    {diff.runs.filter((run) => run.items.length).map((run) => <RunChanges key={run.run_id} run={run} onRevert={onRevert} />)}
    {diff.hidden_items > 0 && <p className="text-xs text-text-tertiary">{diff.hidden_items} change(s) on pages you cannot read</p>}
  </div>;
}
