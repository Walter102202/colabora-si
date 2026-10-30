"use client";

import type { BriefRow, ReviewRow } from "@/lib/agentTasks";
import { CI_LABEL, type CiCheckRow } from "@/lib/agentCi";
import { safeHref } from "@/lib/utils";

const STATUS: Record<ReviewRow["findings"][number]["status"], { mark: string; label: string; cls: string }> = {
  verified: { mark: "✓", label: "verified", cls: "text-green-700 dark:text-green-400" },
  not_found: { mark: "?", label: "not found", cls: "text-yellow-700 dark:text-yellow-400" },
  contradicted: { mark: "✗", label: "contradicted", cls: "text-red-700 dark:text-red-400" },
  unverified: { mark: "–", label: "unverified", cls: "text-text-tertiary" },
};

const VERDICT: Record<ReviewRow["verdict"], string> = { approved: "Approved", changes_requested: "Changes requested", blocked: "Blocked: needs a decision" };

export interface VerificationCardProps { review: ReviewRow | null; brief: BriefRow | null; reviewerName?: string | null; ciChecks?: CiCheckRow[] }

function CiCriterion({ text, check, finding }: { text: string; check?: CiCheckRow; finding?: ReviewRow["findings"][number] }) {
  const state = check?.state ?? "pending";
  const status = STATUS[state === "passed" ? "verified" : state === "failed" ? "contradicted" : "unverified"];
  const url = check?.url ? safeHref(check.url) : null;
  return <li className="flex flex-wrap gap-2">
    <span className={status.cls}>{status.mark}</span><span className="min-w-0 flex-1">{text}</span>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer" className={status.cls}>{CI_LABEL[state]}</a> : <span className={status.cls}>{CI_LABEL[state]}</span>}
    <span className="text-text-secondary">· Review: {STATUS[finding?.status ?? "unverified"].label}{finding?.note ? ` · ${finding.note}` : ""}</span>
  </li>;
}

export function VerificationCard({ review, brief, reviewerName, ciChecks }: VerificationCardProps) {
  const criteria = brief?.done_when ?? [];
  if (!review) {
    if (criteria.length === 0) return <p className="text-xs text-text-tertiary">No acceptance criteria were written.</p>;
    return (
      <ul className="space-y-0.5 text-xs">
        {criteria.map((c) => c.check === "ci" ? <CiCriterion key={c.id} text={c.text} check={ciChecks?.find((r) => r.criterion_id === c.id)} /> : (
          <li key={c.id} className="flex gap-2"><span className="text-text-tertiary">–</span><span>{c.text}</span><span className="text-text-tertiary">· not verified yet</span></li>
        ))}
      </ul>
    );
  }
  const blocking = review.findings.filter((f) => f.severity !== "minor");
  const minors = review.findings.filter((f) => f.severity === "minor");
  const byId = new Map(blocking.filter((f) => f.criterion_id).map((f) => [f.criterion_id!, f]));
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
          if (c.check === "ci") return <CiCriterion key={c.id} text={c.text} check={ciChecks?.find((r) => r.criterion_id === c.id)} finding={f} />;
          const s = STATUS[f?.status ?? "unverified"];
          return (
            <li key={c.id} className="flex gap-2">
              <span className={s.cls}>{s.mark}</span>
              <span className="min-w-0 flex-1">{c.text}{f?.note ? <span className="text-text-secondary"> · {f.note}</span> : null}</span>
              <span className={"shrink-0 " + s.cls}>{s.label}</span>
            </li>
          );
        })}
        {blocking.filter((f) => f.criterion_id && !criteria.some((c) => c.id === f.criterion_id)).map((f) => (
          <li key={f.criterion_id} className="flex gap-2"><span className={STATUS[f.status].cls}>{STATUS[f.status].mark}</span><span>{f.criterion_id}{f.note ? ` · ${f.note}` : ""}</span></li>
        ))}
      </ul>
      {minors.length > 0 && <section className="space-y-1 text-text-secondary" aria-label="Minor, for later">
        <h5 className="font-medium">Minor, for later</h5>
        <ul className="space-y-0.5">{minors.map((f, index) => <li key={index}>{f.note}{f.evidence_ref ? ` · ${f.evidence_ref}` : ""}</li>)}</ul>
      </section>}
      {review.evidence.length > 0 && (
        <p className="text-text-tertiary">Evidence: {review.evidence.map((e) => `${e.kind} ${e.ref}`).join(" · ")}</p>
      )}
    </div>
  );
}
