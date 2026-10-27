"use client";

import { useState } from "react";
import type { ApprovalRow } from "@/lib/agentTasks";
import type { ApprovalDecision } from "@/lib/agentActions";
import { formatRelative } from "@/lib/utils";

export function expiresIn(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "expired";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

// An irreversible action waiting for a person. Approve runs it exactly once.
export function ApprovalCard({
  approval,
  deciderName,
  onDecide,
}: {
  approval: ApprovalRow;
  deciderName?: string | null;
  onDecide: (decision: ApprovalDecision, response: Record<string, unknown> | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useState(() => JSON.stringify(approval.params, null, 2));

  const decide = async (decision: ApprovalDecision, response: Record<string, unknown> | null = null) => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(decision, response);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (approval.status !== "pending") {
    const who = deciderName ?? "someone";
    const when = approval.decided_at ? formatRelative(Date.parse(approval.decided_at)) : "";
    return (
      <p className="rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
        {approval.status === "expired" ? "This approval expired. The agent has to ask again." : `Decided by ${who} ${when}: ${approval.decision ?? approval.status}.`}
      </p>
    );
  }

  const paramsText = JSON.stringify(approval.params);
  const what = [approval.action, paramsText !== "{}" ? paramsText : null, approval.artifact_version ? `deliverable v${approval.artifact_version}` : null].filter(Boolean).join(" · ");
  const has = (o: ApprovalRow["options"][number]) => approval.options.includes(o);

  return (
    <div className="space-y-2 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
      <p className="font-medium">Needs your approval{approval.question ? `: ${approval.question}` : ""}</p>
      <p className="text-xs text-text-secondary">Runs exactly this once: {what || "the requested action"}. Expires in {expiresIn(approval.expires_at)}.</p>
      {editing ? (
        <textarea className="w-full rounded border border-border bg-bg p-2 font-mono text-xs" rows={6} value={params} onChange={(e) => setParams(e.target.value)} />
      ) : (
        paramsText !== "{}" && <pre className="max-h-40 overflow-auto rounded bg-bg p-2 font-mono text-xs">{JSON.stringify(approval.params, null, 2)}</pre>
      )}
      {error && <p className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {has("approve") && !editing && (
          <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" disabled={busy} onClick={() => decide("approve")}>Approve</button>
        )}
        {has("edit") && (
          editing ? (
            <button
              type="button"
              className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                try {
                  const parsed = JSON.parse(params) as Record<string, unknown>;
                  void decide("edit", { params: parsed });
                } catch {
                  setError("The parameters are not valid JSON.");
                }
              }}
            >
              Approve with these changes
            </button>
          ) : (
            <button type="button" className="rounded border border-border px-3 py-1 text-xs hover:bg-bg-secondary" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          )
        )}
        {has("reject") && (
          <button type="button" className="rounded border border-border px-3 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50" disabled={busy} onClick={() => decide("reject")}>Reject</button>
        )}
        {has("ignore") && (
          <button type="button" className="rounded px-3 py-1 text-xs text-text-secondary hover:bg-bg-secondary" disabled={busy} onClick={() => decide("ignore")}>Ignore</button>
        )}
        {editing && (
          <button type="button" className="rounded px-3 py-1 text-xs text-text-secondary hover:bg-bg-secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel edit</button>
        )}
      </div>
    </div>
  );
}
