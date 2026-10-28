import { useId, useState } from "react";
import type { ApprovalRow } from "@/lib/agentTasks";
import type { ApprovalDecision } from "@/lib/agentActions";
import { expiresIn } from "@/lib/agentTaskText";
import { useApprovalFocus } from "@/components/agents/panel/useApprovalFocus";

const KIND = { elicitation: "Question", plan: "Plan to confirm", escalation: "Escalated to you", action: "Decision" } as const;

// A question from the agent (elicitation, plan or escalation). The person
// answers in text or picks one of the offered options.
export function DecisionCard({
  approval,
  onDecide,
  focus = false,
}: {
  approval: ApprovalRow;
  onDecide: (decision: ApprovalDecision, response: Record<string, unknown> | null) => Promise<void>;
  focus?: boolean;
}) {
  const id = useId();
  const { ref: focusRef, id: focusId, ringClass } = useApprovalFocus(focus, approval.id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = Array.isArray(approval.params.choices) ? (approval.params.choices as unknown[]).filter((c): c is string => typeof c === "string") : [];

  const decide = async (decision: ApprovalDecision, response: Record<string, unknown> | null) => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(decision, response);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={focusRef} id={focusId} tabIndex={-1} className={"space-y-2 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm" + ringClass}>
      <p className="font-medium">{KIND[approval.kind]}: {approval.question || "the agent is waiting for you"}</p>
      <p className="text-xs text-text-secondary">Expires in {expiresIn(approval.expires_at)}.</p>
      {choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => (
            <button key={c} type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50" disabled={busy} onClick={() => decide("respond", { text: c, choice: c })}>
              {c}
            </button>
          ))}
        </div>
      )}
      {approval.options.includes("respond") && (
        <div className="space-y-1">
          <label htmlFor={`${id}-answer`} className="sr-only">Your answer</label>
          <textarea id={`${id}-answer`} className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" rows={2} value={text} placeholder="Answer in your own words…" disabled={busy} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-2">
            <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" disabled={busy || !text.trim()} onClick={() => decide("respond", { text: text.trim() })}>Reply</button>
            {approval.options.includes("approve") && (
              <button type="button" className="rounded border border-border px-3 py-1 text-xs hover:bg-bg-secondary" disabled={busy} onClick={() => decide("approve", null)}>Go ahead</button>
            )}
            {approval.options.includes("reject") && (
              <button type="button" className="rounded border border-border px-3 py-1 text-xs hover:bg-bg-secondary" disabled={busy} onClick={() => decide("reject", null)}>Reject</button>
            )}
            {approval.options.includes("ignore") && (
              <button type="button" className="rounded px-3 py-1 text-xs text-text-secondary hover:bg-bg-secondary" disabled={busy} onClick={() => decide("ignore", null)}>Ignore</button>
            )}
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
