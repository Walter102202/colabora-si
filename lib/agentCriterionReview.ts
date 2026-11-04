import type { BriefRow, TaskRow } from "@/lib/agentTasks";
import { isTerminal, waitsForAcceptance } from "@/lib/agentState";

export type ParentAcceptance = "accepted" | "pending" | "unknown";
type Criterion = BriefRow["done_when"][number];

// Authorship comes from the saved brief. Missing authorship stays unspecified.
export function criterionReviewMethod(criterion: Criterion): string {
  if (criterion.check === "human") return criterion.by === "person" ? "Required human review"
    : criterion.by === "agent" ? "The Lead suggested you look" : "Human review";
  return criterion.check === "ci" ? "Checked by CI" : criterion.check === "lead" ? "Checked by the Lead" : "Checked by a deterministic check";
}

// A Lead can accept a subtask while deferring its human checks to the parent.
// Acceptance settles the person's decision; it never changes recorded findings.
export function humanReviewResponsibility(criterion: Criterion, task?: TaskRow, parentAcceptance: ParentAcceptance = "unknown"): string | null {
  if (criterion.check !== "human") return null;
  if (criterion.by !== "person" || !task) return criterionReviewMethod(criterion);
  if (task.state === "done" && task.acceptance === "accepted") {
    if (!task.parent_task_id || task.closed_by) return "Human review settled with acceptance";
    if (parentAcceptance === "accepted") return "Human review settled with the parent job's acceptance";
    return parentAcceptance === "pending" ? "Human review deferred to the parent job. Review it when the job is ready for acceptance."
      : "Human review deferred to the parent job. Its acceptance is not confirmed here.";
  }
  if (isTerminal(task.state)) return "Human review was not settled by acceptance";
  return waitsForAcceptance(task) || (task.state === "input_required" && task.waiting_on === "human")
    ? "Waiting for you" : criterionReviewMethod(criterion);
}
