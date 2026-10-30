import { useState } from "react";
import type { ApprovalRow } from "@/lib/agentTasks";
import type { ApprovalDecision } from "@/lib/agentActions";
import { describeApproval } from "@/lib/agentApprovalText";
import { expiresIn } from "@/lib/agentTaskText";
import { ApprovalCard } from "@/components/agents/panel/ApprovalCard";
import { useApprovalFocus } from "@/components/agents/panel/useApprovalFocus";

export interface ApprovalGroupCardProps {
  approvals: ApprovalRow[];
  focusApprovalId?: string | null;
  onDecide: (id: string, decision: ApprovalDecision, response: Record<string, unknown> | null) => Promise<void>;
}

function ApprovalItem({ approval, checked, busy, error, focus, onSelect }: {
  approval: ApprovalRow; checked: boolean; busy: boolean; error?: string; focus: boolean; onSelect: (checked: boolean) => void;
}) {
  const { ref, id, ringClass } = useApprovalFocus(focus, approval.id);
  const described = describeApproval(approval.action, approval.params, { artifactVersion: approval.artifact_version });
  return <li><div ref={ref} id={id} tabIndex={-1} className={`space-y-1 rounded border border-border p-2${ringClass}`}>
    <label className="flex items-start gap-2 font-medium">
      <input type="checkbox" checked={checked} disabled={busy} onChange={(event) => onSelect(event.target.checked)} />
      {approval.question || described.what}
    </label>
    <p className="text-text-secondary">{described.what}. {described.effect} Expires in {expiresIn(approval.expires_at)}.</p>
    {Object.keys(approval.params).length > 0 && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-bg p-2">{JSON.stringify(approval.params, null, 2)}</pre>}
    {error && <p role="alert" className="text-red-700 dark:text-red-400">{error}</p>}
  </div></li>;
}

export function ApprovalGroupCard({ approvals, onDecide, focusApprovalId }: ApprovalGroupCardProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pending = approvals.filter((a) => a.status === "pending" && a.kind === "action");
  if (!pending.length) return null;
  // Keep failed rows visible when successful siblings disappear through Realtime.
  if (pending.length === 1 && !busy && !errors[pending[0].id]) {
    const approval = pending[0];
    return <ApprovalCard approval={approval} focus={focusApprovalId === approval.id}
      onDecide={(decision, response) => onDecide(approval.id, decision, response)} />;
  }
  const chosen = pending.filter((a) => selected.has(a.id));
  const decide = async (decision: "approve" | "reject") => {
    if (busy || !chosen.length || chosen.some((a) => !a.options.includes(decision))) return;
    setBusy(true); setErrors({});
    for (const approval of chosen) {
      try {
        await onDecide(approval.id, decision, null);
        setSelected((current) => new Set([...current].filter((id) => id !== approval.id)));
      } catch (error) {
        setErrors((current) => ({ ...current, [approval.id]: error instanceof Error ? error.message : String(error) }));
      }
    }
    setBusy(false);
  };
  return <section className="space-y-2 rounded-md border border-accent/40 bg-accent/5 p-3 text-xs" aria-label="Pending approvals">
    <h4 className="font-medium">Choose the actions to decide</h4>
    <ul className="space-y-2">{pending.map((approval) => <ApprovalItem key={approval.id} approval={approval}
      checked={selected.has(approval.id)} busy={busy} error={errors[approval.id]} focus={focusApprovalId === approval.id}
      onSelect={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(approval.id); else next.delete(approval.id); return next; })} />)}</ul>
    <div className="flex gap-2">
      <button type="button" className="rounded bg-accent px-3 py-1 text-white disabled:opacity-50" disabled={busy || !chosen.length || chosen.some((a) => !a.options.includes("approve"))} onClick={() => void decide("approve")}>Approve selected</button>
      <button type="button" className="rounded border border-border px-3 py-1 disabled:opacity-50" disabled={busy || !chosen.length || chosen.some((a) => !a.options.includes("reject"))} onClick={() => void decide("reject")}>Reject selected</button>
    </div>
  </section>;
}
