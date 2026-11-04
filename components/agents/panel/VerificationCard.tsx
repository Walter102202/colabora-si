"use client";

import type { BriefRow, ReviewRow, TaskRow } from "@/lib/agentTasks";
import { CI_LABEL, type CiCheckRow } from "@/lib/agentCi";
import { safeHref } from "@/lib/utils";
import { humanReviewResponsibility, type ParentAcceptance } from "@/lib/agentCriterionReview";

const STATUS: Record<ReviewRow["findings"][number]["status"], { mark: string; label: string; cls: string }> = {
  verified: { mark: "✓", label: "verified", cls: "text-green-700 dark:text-green-400" },
  not_found: { mark: "?", label: "not found", cls: "text-yellow-700 dark:text-yellow-400" },
  contradicted: { mark: "✗", label: "contradicted", cls: "text-red-700 dark:text-red-400" },
  unverified: { mark: "–", label: "unverified", cls: "text-text-tertiary" },
};

const VERDICT: Record<ReviewRow["verdict"], string> = { approved: "Approved", changes_requested: "Changes requested", blocked: "Blocked: needs a decision" };

export interface VerificationCardProps {
  review: ReviewRow | null;
  brief: BriefRow | null;
  reviewerName?: string | null;
  ciChecks?: CiCheckRow[];
  task?: TaskRow;
  parentAcceptance?: ParentAcceptance;
}

function CriterionResult({ criterion, check, finding, reviewed, responsibility }: {
  criterion: BriefRow["done_when"][number];
  check?: CiCheckRow;
  finding?: ReviewRow["findings"][number];
  reviewed: boolean;
  responsibility: string | null;
}) {
  const ci = criterion.check === "ci";
  const state = check?.state ?? "pending";
  const status = STATUS[ci ? state === "passed" ? "verified" : state === "failed" ? "contradicted" : "unverified" : finding?.status ?? "unverified"];
  const url = ci && check?.url ? safeHref(check.url) : null;
  const label = ci ? CI_LABEL[state] : reviewed ? status.label : "not verified yet";
  return <li data-criterion-id={criterion.id} className="flex items-start gap-2">
    <span aria-hidden="true" className={`shrink-0 ${status.cls}`}>{status.mark}</span>
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="min-w-0 basis-40 flex-1 whitespace-pre-wrap break-words">{criterion.text}</span>
        {url ? <a href={url} target="_blank" rel="noopener noreferrer" className={status.cls}>{label}</a> : <span className={status.cls}>{label}</span>}
      </div>
      {ci && <p className="text-text-secondary">Review: {STATUS[finding?.status ?? "unverified"].label}</p>}
      {finding?.note && <p className="whitespace-pre-wrap break-words text-text-secondary">{finding.note}</p>}
      {finding?.evidence_ref && <p className="break-all text-text-secondary">Evidence: {finding.evidence_ref}</p>}
      {responsibility && <p className="whitespace-pre-wrap break-words text-text-secondary">{responsibility}</p>}
    </div>
  </li>;
}

export function VerificationCard({ review, brief, reviewerName, ciChecks, task, parentAcceptance = "unknown" }: VerificationCardProps) {
  const criteria = brief?.done_when ?? [];
  if (!review && criteria.length === 0) return <p className="text-xs text-text-tertiary">No acceptance criteria were written.</p>;
  const blocking = review?.findings.filter((f) => f.severity !== "minor") ?? [];
  const minors = review?.findings.filter((f) => f.severity === "minor") ?? [];
  const byId = new Map(blocking.filter((f) => f.criterion_id).map((f) => [f.criterion_id!, f]));
  return (
    <div className="space-y-1 text-xs">
      {review && <p>
        <span className="font-medium">{VERDICT[review.verdict]}</span>
        <span className="text-text-secondary"> · by {reviewerName ?? (review.reviewer_type === "human" ? "a person" : "the Lead")} · deliverable v{review.artifact_version} · brief v{review.brief_version}</span>
      </p>}
      {review?.outdated_by && (
        <p className="text-yellow-700 dark:text-yellow-400">
          Review outdated: {review.outdated_by === "artifact" ? "the deliverable changed after the review." : "the brief changed after the review."}
        </p>
      )}
      <ul className="space-y-3">
        {criteria.map((criterion) => <CriterionResult key={criterion.id} criterion={criterion} finding={byId.get(criterion.id)}
          check={ciChecks?.find((row) => row.criterion_id === criterion.id)} reviewed={!!review}
          responsibility={humanReviewResponsibility(criterion, task, parentAcceptance)} />)}
        {blocking.filter((f) => f.criterion_id && !criteria.some((c) => c.id === f.criterion_id)).map((f) => (
          <li key={f.criterion_id} className="flex items-start gap-2"><span className={STATUS[f.status].cls}>{STATUS[f.status].mark}</span><span className="min-w-0 break-words">{f.criterion_id}{f.note ? ` · ${f.note}` : ""}</span></li>
        ))}
      </ul>
      {minors.length > 0 && <section className="space-y-1 text-text-secondary" aria-label="Minor, for later">
        <h5 className="font-medium">Minor, for later</h5>
        <ul className="space-y-0.5">{minors.map((f, index) => <li key={index}>{f.note}{f.evidence_ref ? ` · ${f.evidence_ref}` : ""}</li>)}</ul>
      </section>}
      {!!review?.evidence.length && (
        <p className="break-words text-text-tertiary">Evidence: {review.evidence.map((e) => `${e.kind} ${e.ref}`).join(" · ")}</p>
      )}
    </div>
  );
}
