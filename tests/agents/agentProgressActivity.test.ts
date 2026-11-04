import { describe, expect, it } from "vitest";
import { buildProgressMilestones, type ProgressActivityInput } from "@/lib/agentProgressActivity";
import type { ActivityRow, ReviewRow, TaskRow } from "@/lib/agentTasks";

const time = "2026-11-04T12:00:00.000Z";
const sha = "0123456789abcdef0123456789abcdef01234567";
const job: TaskRow = {
  id: "job", workspace_id: "workspace", context_id: "context", db_page_id: "database", row_page_id: "job-page",
  title: "Fix signup", delegate_agent_id: "lead", owner_user_id: "person", parent_task_id: null, depends_on_task_ids: [],
  state: "done", review_state: "approved", acceptance: "accepted", waiting_on: null, brief_version: 2, brief_stale: false,
  active_run_id: null, review_rounds: 1, max_review_rounds: 3, cost_usd: 0, last_activity_at: time,
  created_at: time, updated_at: time, closed_at: time, closed_by: null,
};
const child: TaskRow = { ...job, id: "child", row_page_id: "child-page", title: "Verify signup", parent_task_id: job.id, delegate_agent_id: "worker" };
const activity = (body: ActivityRow["body"], patch: Partial<ActivityRow> = {}): ActivityRow => ({
  id: "closure", task_id: job.id, run_id: null, seq: 5, type: "response", body,
  ephemeral: false, author_type: "agent", author_id: "lead", created_at: time, ...patch,
});
const build = (activities: ActivityRow[], patch: Partial<Omit<ProgressActivityInput, "activities">> = {}) => buildProgressMilestones({
  task: job, subtasks: [child], activities, reviews: [], agentNames: { lead: "Claude Code", worker: "Codex", reviewer: "Independent reviewer" }, userId: "person", ...patch,
});
const jobClosure = { rule: "ci_job", sha, checks: [] };
const subtaskClosure = { rule: "lead_review", verdict: "accepted", evidence: [] };

describe("recorded autonomous closure milestones", () => {
  it("makes a CI closure the latest milestone, with the System author and complete recorded commit/check evidence", () => {
    const checks = [{ check: "signup", state: "passed", url: "https://github.com/example/project/actions/runs/42", sources: [job.id, child.id] }];
    const events = build([
      activity({ text: "Signup verified.", submit: true }, { id: "submission", run_id: "run", seq: 4, author_id: "worker" }),
      activity({ rule: "ci_job", text: "Closed: CI passed on 0123456 and every subtask was reviewed.", sha, checks }, { author_type: "system", author_id: "person" }),
    ]);
    expect(events.map((event) => event.label)).toEqual(["Submitted for review", "Delivery accepted"]);
    expect(events.at(-1)).toMatchObject({ id: "activity:closure", taskId: job.id, pageId: job.row_page_id, author: "System", source: "activity" });
    expect(events.at(-1)?.detail).toContain("Closed: CI passed on 0123456");
    for (const value of [sha, "signup", "passed", checks[0].url, job.id, child.id]) expect(events.at(-1)?.detail).toContain(value);
  });

  it.each([
    { name: "unconnected CI", sha, checks: [{ check: "build", state: "not_connected", sources: [child.id] }] },
    { name: "no final commit", sha: null, checks: [{ check: "build", state: "no_commit", sources: [child.id] }] },
    { name: "no CI requirements", sha: null, checks: [] },
  ])("keeps Lead closure with $name distinct from a passing CI result", ({ sha: recordedSha, checks }) => {
    const events = build([activity({ rule: "ci_job", text: "Closed: the Lead verified the deliveries and every subtask was accepted.", sha: recordedSha, checks })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ label: "Delivery accepted", author: "Claude Code" });
    expect(events[0].detail).toContain("the Lead verified the deliveries");
    expect(events[0].detail).not.toMatch(/CI passed|checks passed|approved by you|merged|deployed/i);
    if (checks.length) expect(events[0].detail).toContain(checks[0].state.replaceAll("_", " "));
  });

  it("uses a neutral fallback for a structured closure without text", () => {
    const events = build([activity(jobClosure)]);
    expect(events[0]?.label).toBe("Delivery accepted");
    expect(events[0]?.detail).toContain(sha);
    expect(events[0]?.detail).not.toMatch(/CI passed|human approval|merged|deployed/i);
  });

  it.each(["policy", "deterministic", "lead_review"])("recognizes a %s subtask closure and preserves the actual reviewer and all evidence", (rule) => {
    const evidence = [{ kind: "command", ref: "npm test -- signup", hash: "sha256:checked-output", exit_code: 0, note: "All cases include trailing whitespace." }];
    const events = build([activity({ verdict: "accepted", rule, text: "Closed by the reviewer.", evidence }, { task_id: child.id, author_id: "reviewer" })]);
    expect(events[0]).toMatchObject({ label: "Delivery accepted", taskId: child.id, author: "Independent reviewer", taskTitle: child.title });
    for (const value of ["Closed by the reviewer.", evidence[0].ref, evidence[0].hash, "exit_code", "0", evidence[0].note]) expect(events[0].detail).toContain(value);
  });

  it("keeps deferred CI and human verification visible instead of presenting them as completed checks", () => {
    const ci = [{ criterion_id: "ci-1", check: "signup", state: "pending", repo: "example/project", sha, url: "https://example.com/check", sources: [child.id] }];
    const human = [{ criterion_id: "h-1", text: "Confirm the copy feels right", task_id: child.id }];
    const events = build([activity({
      verdict: "accepted", rule: "ci_deferred", evidence: [{ kind: "page", ref: "verification-page" }],
      text: "Closed by the lead. The final checks belong to the job.", ci_deferred: ci, human_deferred: human,
    }, { task_id: child.id })]);
    expect(events[0]?.label).toBe("Delivery accepted");
    const detail = events[0]?.detail ?? "";
    for (const value of ["CI checks deferred to the job's final commit", "Human criteria deferred to the job's acceptance", "pending", sha, ci[0].url, "ci-1", "h-1", human[0].text, child.id, "verification-page"]) expect(detail).toContain(value);
    expect(detail).not.toMatch(/CI passed|human verified|all checks passed/i);
  });

  it("recognizes a human-deferred subtask closure without claiming the person already accepted the job", () => {
    const events = build([activity({ ...subtaskClosure, rule: "human_deferred", human_deferred: [{ criterion_id: "h-1", text: "Approve the copy", task_id: child.id }] }, { task_id: child.id })]);
    expect(events[0]?.label).toBe("Delivery accepted");
    expect(events[0]?.detail).toContain("Human criteria deferred to the job's acceptance");
    expect(events[0]?.detail).toContain("Approve the copy");
    expect(events[0]?.detail).not.toMatch(/You accepted|human verified/i);
  });

  it.each([
    ["plain response text", activity({ text: "Closed: everything accepted." })],
    ["an unqualified verdict", activity({ verdict: "accepted", evidence: [] }, { task_id: child.id })],
    ["an unknown closure rule", activity({ ...subtaskClosure, rule: "agent_says_done" }, { task_id: child.id })],
    ["a rejected subtask", activity({ ...subtaskClosure, verdict: "rejected" }, { task_id: child.id })],
    ["a run message imitating a job closure", activity(jobClosure, { run_id: "agent-run" })],
    ["a run message imitating a subtask closure", activity(subtaskClosure, { task_id: child.id, run_id: "agent-run" })],
    ["an ephemeral response", activity(jobClosure, { ephemeral: true })],
    ["a human response", activity(jobClosure, { author_type: "human", author_id: "person" })],
    ["a System subtask response", activity(subtaskClosure, { task_id: child.id, author_type: "system" })],
    ["a job closure on a subtask", activity(jobClosure, { task_id: child.id })],
    ["a subtask closure on a job", activity(subtaskClosure)],
    ["a job response without recorded checks", activity({ rule: "ci_job", sha })],
    ["a job response without a recorded commit field", activity({ rule: "ci_job", checks: [] })],
    ["a subtask response without recorded evidence", activity({ verdict: "accepted", rule: "lead_review" }, { task_id: child.id })],
    ["a CI deferral without its checks", activity({ ...subtaskClosure, rule: "ci_deferred" }, { task_id: child.id })],
    ["a human deferral without its criteria", activity({ ...subtaskClosure, rule: "human_deferred" }, { task_id: child.id })],
  ])("does not promote %s to an acceptance milestone", (_name, event) => {
    expect(build([event as ActivityRow])).toEqual([]);
  });

  it("keeps historical closure evidence after the task is reopened", () => {
    const reopened = { ...job, state: "working", acceptance: "pending", closed_at: null } satisfies TaskRow;
    const events = build([activity(jobClosure)], { task: reopened });
    expect(events[0]).toMatchObject({ label: "Delivery accepted", createdAt: time });
  });

  it("preserves review/submission deduplication, stable order and all original history", () => {
    const review: ReviewRow = {
      id: "review", task_id: child.id, run_id: "review-run", reviewer_type: "agent", reviewer_id: "reviewer", artifact_id: "artifact",
      artifact_version: 2, brief_version: 2, verdict: "approved", findings: [], evidence: [{ kind: "url", ref: "https://example.com/review" }],
      outdated_by: null, outdated_at: null, created_at: "2026-11-04T11:59:00.000Z",
    };
    const activities = [
      activity(jobClosure, { id: "job-accepted", seq: 8 }),
      activity({ text: "Delivered.", submit: true }, { id: "submitted", run_id: "run", seq: 6 }),
      activity({ op: "submit_for_review" }, { id: "submission-echo", type: "action", run_id: "run", seq: 5 }),
      activity({ text: "Review feedback", review_id: review.id }, { id: "review-echo", task_id: child.id, type: "prompt", seq: 2 }),
      activity(subtaskClosure, { id: "child-accepted", task_id: child.id, created_at: "2026-11-04T11:59:30.000Z" }),
      activity({ signal: "continue", text: "Continue with the next step" }, { id: "continued", type: "prompt", seq: 9 }),
      activity(jobClosure, { id: "unrelated", task_id: "another-job" }),
      activity({ text: "An ordinary conversation message" }, { id: "message", run_id: "run" }),
    ];
    const snapshot = structuredClone(activities);
    const events = build([...activities, activities[0]], { reviews: [review] });
    expect(events.map((event) => event.id)).toEqual(["review:review", "activity:child-accepted", "activity:submitted", "activity:job-accepted", "activity:continued"]);
    expect(activities).toEqual(snapshot);
    expect(review.verdict).toBe("approved");
  });
});
