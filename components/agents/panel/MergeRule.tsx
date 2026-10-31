import type { MergeCondition } from "@/lib/agentActions";
import { useQueuedChoice } from "@/components/agents/panel/useQueuedChoice";

export function MergeRule({ enabled, onChange }: { enabled: boolean; onChange: (conditions: MergeCondition[] | null) => Promise<void> }) {
  const choice = useQueuedChoice<boolean>();
  return <div className="space-y-1 text-xs">
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={choice.pending ? choice.pending.value : enabled} aria-busy={choice.busy}
        onChange={(event) => void choice.choose(event.target.checked, (value) => onChange(value ? ["review_approved", "ci_green"] : null))} />
      Merge when the review is approved and CI is green
    </label>
    <p className="text-text-tertiary">The server checks both before each merge. If one fails, you decide.</p>
    {choice.error && <p role="alert" className="text-red-700 dark:text-red-400">{choice.error}</p>}
  </div>;
}
