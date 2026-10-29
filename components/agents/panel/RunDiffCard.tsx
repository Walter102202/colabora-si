import { useState } from "react";
import { revertableKeys, statusLabel, wordDiff, type RunDiff, type TaskDiff } from "@/lib/agentRunDiff";

type Revert = (runId: string, keys: string[]) => Promise<void>;

function RunChanges({ run, onRevert }: { run: RunDiff; onRevert?: Revert }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = revertableKeys(run).filter((key) => selected.includes(key));
  const revert = async () => {
    if (!onRevert || !keys.length) return;
    setBusy(true); setError(null);
    try {
      await onRevert(run.run_id, keys);
      setSelected([]); setConfirming(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-2">
      <h5 className="text-xs font-medium">Changes by {run.harness}</h5>
      <ul className="space-y-2 text-xs">
        {run.items.map((item) => {
          const parts = wordDiff(item.before_text ?? "", item.after_text ?? "");
          return (
            <li key={item.key} className="space-y-1 rounded border border-border p-2">
              {onRevert && item.status === "revertable" ? (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={keys.includes(item.key)} disabled={busy} onChange={(e) => setSelected((prev) => e.target.checked ? [...prev, item.key] : prev.filter((key) => key !== item.key))} />
                  {item.summary}
                </label>
              ) : <p>{item.summary}</p>}
              <p className="text-text-secondary">{statusLabel(item.status)}</p>
              {item.before_text && <p>Before: {parts.filter((p) => p.op !== "add").map((p, i) => <span key={i}>{i > 0 && " "}{p.op === "del" ? <del className="bg-red-500/10">{p.text}</del> : p.text}</span>)}</p>}
              {item.after_text && <p>After: {parts.filter((p) => p.op !== "del").map((p, i) => <span key={i}>{i > 0 && " "}{p.op === "add" ? <ins className="bg-green-500/10">{p.text}</ins> : p.text}</span>)}</p>}
            </li>
          );
        })}
      </ul>
      {onRevert && !confirming && <button type="button" className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50" disabled={!keys.length || busy} onClick={() => setConfirming(true)}>Revert selected</button>}
      {onRevert && confirming && <div className="flex items-center gap-2 text-xs">
        <span>Revert {keys.length} changes?</span>
        <button type="button" className="rounded bg-accent px-3 py-1 text-white disabled:opacity-50" disabled={busy || !keys.length} onClick={() => void revert()}>Confirm</button>
        <button type="button" className="rounded border border-border px-3 py-1 disabled:opacity-50" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
      </div>}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}

export function RunDiffCard({ diff, onRevert }: { diff: TaskDiff; onRevert?: Revert }) {
  return <div className="space-y-3">
    {diff.runs.filter((run) => run.items.length).map((run) => <RunChanges key={run.run_id} run={run} onRevert={onRevert} />)}
    {diff.hidden_items > 0 && <p className="text-xs text-text-tertiary">{diff.hidden_items} change(s) on pages you cannot read</p>}
  </div>;
}
