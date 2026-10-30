import { useId, useState } from "react";
import type { ArtifactRow, BriefRow, ReviewRow, TaskRow } from "@/lib/agentTasks";
import type { CiCheckRow } from "@/lib/agentCi";
import { VerificationCard } from "@/components/agents/panel/VerificationCard";

export type FindingStatus = "verified" | "not_found" | "contradicted" | "unverified";
export type ReviewVerdict = "approved" | "changes_requested" | "blocked";
export interface ReviewFinding {
  criterion_id: string;
  status: FindingStatus;
  note?: string;
}
const STATUSES: { value: FindingStatus; label: string }[] = [
  { value: "verified", label: "verified" },
  { value: "not_found", label: "not found" },
  { value: "contradicted", label: "contradicted" },
  { value: "unverified", label: "unverified" },
];

// Verification of the deliverable: what the Lead (or a person) found per
// criterion, the review round, and a way for the person to take the review.
// Pure: `onReview` performs the review for this task and the deliverable shown.
export function LeadReviewCard({
  task,
  review,
  brief,
  ciChecks,
  artifact,
  reviewerName,
  onReview,
}: {
  task: TaskRow;
  review: ReviewRow | null;
  brief: BriefRow | null;
  ciChecks?: CiCheckRow[];
  artifact: ArtifactRow | null;
  reviewerName?: string | null;
  onReview: (verdict: ReviewVerdict, findings: ReviewFinding[], artifactId: string | null) => Promise<void>;
}) {
  const id = useId();
  const [taking, setTaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const criteria = brief?.done_when ?? [];
  const [findings, setFindings] = useState<Record<string, { status: FindingStatus; note: string }>>({});

  const canReview = task.state === "ready_for_review" && !!artifact;
  const byLead = review?.reviewer_type === "agent";
  // review_state stays 'pending' after a close (close_task leaves it), so only a task in review is being reviewed:
  // a subtask by the Lead of its parent, a top-level task by the person.
  const inReview = task.state === "ready_for_review" && task.review_state === "pending";
  const roundLine =
    inReview
      ? task.parent_task_id ? `Lead reviewing · round ${task.review_rounds + 1} of ${task.max_review_rounds}` : "Waiting for your review"
      : task.review_rounds > 0
        ? `Round ${task.review_rounds} of ${task.max_review_rounds}${task.review_rounds >= task.max_review_rounds ? " · escalated to you" : ""}`
        : null;

  const submit = async (verdict: ReviewVerdict) => {
    setBusy(true);
    setError(null);
    try {
      await onReview(
        verdict,
        criteria.map((c) => ({ criterion_id: c.id, status: findings[c.id]?.status ?? "unverified", note: findings[c.id]?.note || undefined })),
        artifact?.id ?? null,
      );
      setTaking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {roundLine && <p className="text-xs text-text-secondary">{roundLine}</p>}
      <VerificationCard review={review} brief={brief} ciChecks={ciChecks} reviewerName={reviewerName ?? (byLead ? "the Lead" : null)} />
      {canReview && !taking && (
        <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" onClick={() => setTaking(true)}>
          {review ? "Take the review" : "Review it yourself"}
        </button>
      )}
      {taking && (
        <div className="space-y-2 rounded-md border border-border p-2 text-xs">
          <p className="text-text-secondary">Mark each criterion against deliverable v{artifact?.version ?? "?"}. Your review replaces the one from the Lead for this version.</p>
          {criteria.length === 0 && <p className="text-text-tertiary">No criteria were written; you can still approve or request changes.</p>}
          <ul className="space-y-1">
            {criteria.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">{c.text}</span>
                <label htmlFor={`${id}-status-${c.id}`} className="sr-only">Status of: {c.text}</label>
                <select
                  id={`${id}-status-${c.id}`}
                  className="rounded border border-border bg-bg px-1 py-0.5"
                  value={findings[c.id]?.status ?? "unverified"}
                  onChange={(e) => setFindings({ ...findings, [c.id]: { status: e.target.value as FindingStatus, note: findings[c.id]?.note ?? "" } })}
                >
                  {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                <label htmlFor={`${id}-note-${c.id}`} className="sr-only">Note on: {c.text}</label>
                <input
                  id={`${id}-note-${c.id}`}
                  className="w-40 rounded border border-border bg-bg px-1 py-0.5"
                  placeholder="note"
                  value={findings[c.id]?.note ?? ""}
                  onChange={(e) => setFindings({ ...findings, [c.id]: { status: findings[c.id]?.status ?? "unverified", note: e.target.value } })}
                />
              </li>
            ))}
          </ul>
          {error && <p className="text-red-700 dark:text-red-400">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded bg-accent px-2 py-1 text-white disabled:opacity-50" disabled={busy} onClick={() => submit("approved")}>Approve</button>
            <button type="button" className="rounded border border-border px-2 py-1 hover:bg-bg-secondary disabled:opacity-50" disabled={busy} onClick={() => submit("changes_requested")}>Request changes</button>
            <button type="button" className="rounded border border-border px-2 py-1 hover:bg-bg-secondary disabled:opacity-50" disabled={busy} onClick={() => submit("blocked")}>Blocked: needs a decision</button>
            <button type="button" className="rounded px-2 py-1 text-text-secondary hover:bg-bg-secondary" disabled={busy} onClick={() => setTaking(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
