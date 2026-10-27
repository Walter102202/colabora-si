"use client";

import type { BriefRow, ReviewRow } from "@/lib/agentTasks";

const STATUS: Record<ReviewRow["findings"][number]["status"], { mark: string; label: string; cls: string }> = {
  verified: { mark: "✓", label: "verified", cls: "text-green-700 dark:text-green-400" },
  not_found: { mark: "?", label: "not found", cls: "text-yellow-700 dark:text-yellow-400" },
  contradicted: { mark: "✗", label: "contradicted", cls: "text-red-700 dark:text-red-400" },
  unverified: { mark: "–", label: "unverified", cls: "text-text-tertiary" },
};

const VERDICT: Record<ReviewRow["verdict"], string> = { approved: "Approved", changes_requested: "Changes requested", blocked: "Blocked: needs a decision" };

export function VerificationCard({ review, brief, reviewerName }: { review: ReviewRow | null; brief: BriefRow | null; reviewerName?: string | null }) {
  const criteria = brief?.done_when ?? [];
  if (!review) {
    if (criteria.length === 0) return <p className="text-xs text-text-tertiary">No acceptance criteria were written.</p>;
    return (
      <ul className="space-y-0.5 text-xs">
        {criteria.map((c) => (
          <li key={c.id} className="flex gap-2"><span className="text-text-tertiary">–</span><span>{c.text}</span><span className="text-text-tertiary">· not verified yet</span></li>
        ))}
      </ul>
    );
  }
  const byId = new Map(review.findings.map((f) => [f.criterion_id, f]));
  return (
    <div className="space-y-1 text-xs">
      <p>
        <span className="font-medium">{VERDICT[review.verdict]}</span>
        <span className="text-text-secondary"> · by {reviewerName ?? (review.reviewer_type === "human" ? "a person" : "the Lead")} · deliverable v{review.artifact_version} · brief v{review.brief_version}</span>
      </p>
      {review.outdated_by && (
        <p className="text-yellow-700 dark:text-yellow-400">
          Review outdated: {review.outdated_by === "artifact" ? "the deliverable changed after the review." : "the brief changed after the review."}
        </p>
      )}
      <ul className="space-y-0.5">
        {criteria.map((c) => {
          const f = byId.get(c.id);
          const s = STATUS[f?.status ?? "unverified"];
          return (
            <li key={c.id} className="flex gap-2">
              <span className={s.cls}>{s.mark}</span>
              <span className="min-w-0 flex-1">{c.text}{f?.note ? <span className="text-text-secondary"> · {f.note}</span> : null}</span>
              <span className={"shrink-0 " + s.cls}>{s.label}</span>
            </li>
          );
        })}
        {review.findings.filter((f) => !criteria.some((c) => c.id === f.criterion_id)).map((f) => (
          <li key={f.criterion_id} className="flex gap-2"><span className={STATUS[f.status].cls}>{STATUS[f.status].mark}</span><span>{f.criterion_id}{f.note ? ` · ${f.note}` : ""}</span></li>
        ))}
      </ul>
      {review.evidence.length > 0 && (
        <p className="text-text-tertiary">Evidence: {review.evidence.map((e) => `${e.kind} ${e.ref}`).join(" · ")}</p>
      )}
    </div>
  );
}
