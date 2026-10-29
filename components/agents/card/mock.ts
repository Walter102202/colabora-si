import type { CardData, TaskCardData, WaitingListData } from "@/lib/agentCard";
import type { ToolResult } from "@/lib/agentCardHost";
import type { ActivityRow, ApprovalRow, ArtifactRow, BriefRow, ReviewRow, RunRow, TaskRow } from "@/lib/agentTasks";
import type { CardActions } from "@/components/agents/card/Card";

// Fake data for `apps/card.html?mock=<scenario>`: renders the card without a
// host, so the views can be checked in a browser. Scenarios: 1 (ready for
// review, Lead review attached), approval (irreversible action), question
// (elicitation), done, list (waiting on you), denied (server wants the app).

const APP_URL = "https://colabora.example";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const task: TaskRow = {
  id: "t-demo", workspace_id: "w1", context_id: "c1", db_page_id: "db1", row_page_id: "row1",
  title: "Clean the leads table and flag duplicates", delegate_agent_id: "a-worker", owner_user_id: "u1", parent_task_id: null,
  depends_on_task_ids: [], state: "ready_for_review", review_state: "changes_requested", acceptance: "pending", waiting_on: null,
  brief_version: 2, brief_stale: false, active_run_id: null, review_rounds: 1, max_review_rounds: 2, cost_usd: 0.0421,
  last_activity_at: minutesAgo(4), created_at: minutesAgo(90), updated_at: minutesAgo(4), closed_at: null, closed_by: null,
};

const run: RunRow = {
  id: "run-2", task_id: task.id, agent_id: "a-worker", harness: "codex", brief_version: 2, status: "waiting", stop_requested_at: null,
  stop_acked_at: null, last_signal_at: minutesAgo(2), stale_at: null, waiting_on_task_id: null, input_tokens: 18_400, output_tokens: 2_100,
  model: "muse-spark-open-1026", cost_usd: 0.0421, cost_kind: "measured", error_message: null, started_at: minutesAgo(30), ended_at: null,
};

const brief: BriefRow = {
  task_id: task.id, version: 2, objective: "Deduplicate the Leads database and flag rows with missing emails.",
  constraints: "Do not delete rows; add a \"Duplicate of\" relation instead.",
  done_when: [
    { id: "c1", text: "Every duplicate row points to its original", check: "human" },
    { id: "c2", text: "Rows without email carry the \"Missing email\" tag", check: "deterministic" },
    { id: "c3", text: "A summary page lists the counts", check: "human" },
  ],
  decisions: [], sources: [{ kind: "page", ref: "leads-db", trust: "internal" }], open_questions: [], next_step: "",
  policies: {}, author_type: "human", created_at: minutesAgo(80),
};

const artifact: ArtifactRow = {
  id: "art-2", task_id: task.id, run_id: "run-2", kind: "page", ref: "summary-page", version: 2, page_revision: 14,
  title: "Leads cleanup summary", satisfies: ["c1", "c2", "c3"], author_type: "agent", author_id: "a-worker", superseded_by: null, created_at: minutesAgo(5),
};

const review: ReviewRow = {
  id: "rev-1", task_id: task.id, run_id: "lead-run", reviewer_type: "agent", reviewer_id: "a-lead", artifact_id: "art-2", artifact_version: 2,
  brief_version: 2, verdict: "changes_requested",
  findings: [
    { criterion_id: "c1", status: "verified", evidence_ref: "#b-12" },
    { criterion_id: "c2", status: "contradicted", note: "Row 41 has no email and no tag" },
    { criterion_id: "c3", status: "verified" },
  ],
  evidence: [{ kind: "page", ref: "summary-page" }], outdated_by: null, outdated_at: null, created_at: minutesAgo(3),
};

const activities: ActivityRow[] = [
  { id: "ac1", task_id: task.id, run_id: "run-1", seq: 1, type: "action", body: { op: "claim" }, ephemeral: false, author_type: "agent", author_id: "a-worker", created_at: minutesAgo(30) },
  { id: "ac2", task_id: task.id, run_id: "run-1", seq: 2, type: "thought", body: { text: "Scanning 312 rows for repeated emails and names." }, ephemeral: false, author_type: "agent", author_id: "a-worker", created_at: minutesAgo(28) },
  { id: "ac3", task_id: task.id, run_id: "run-1", seq: 3, type: "action", body: { op: "update_row", summary: "Linked 17 duplicates to their originals" }, ephemeral: false, author_type: "agent", author_id: "a-worker", created_at: minutesAgo(20) },
  { id: "ac4", task_id: task.id, run_id: "run-1", seq: 4, type: "action", body: { op: "append_blocks", summary: "Wrote the summary page" }, ephemeral: false, author_type: "agent", author_id: "a-worker", created_at: minutesAgo(8) },
  { id: "ac5", task_id: task.id, run_id: "run-1", seq: 5, type: "action", body: { op: "submit_for_review" }, ephemeral: false, author_type: "agent", author_id: "a-worker", created_at: minutesAgo(5) },
  { id: "ac6", task_id: task.id, run_id: null, seq: 6, type: "prompt", body: { text: "c2 contradicted: row 41 has no email and no tag", signal: "feedback", source: "lead" }, ephemeral: false, author_type: "agent", author_id: "a-lead", created_at: minutesAgo(3) },
];

const actionApproval: ApprovalRow = {
  id: "ap-action", task_id: task.id, run_id: "run-2", kind: "action", action: "send_email", params: { to: "ops@example.com", subject: "Leads cleanup done" },
  artifact_version: 2, question: "Send the summary to the ops mailbox?", options: ["approve", "edit", "reject"], status: "pending", decision: null,
  response: null, decided_by: null, decided_at: null, expires_at: inHours(20), created_at: minutesAgo(1),
};

const question: ApprovalRow = {
  id: "ap-question", task_id: task.id, run_id: "run-2", kind: "elicitation", action: null, params: { choices: ["Keep the oldest", "Keep the most complete"] },
  artifact_version: null, question: "Two rows are duplicates with different phone numbers. Which one stays?", options: ["respond", "ignore"], status: "pending",
  decision: null, response: null, decided_by: null, decided_at: null, expires_at: inHours(44), created_at: minutesAgo(1),
};

const subtask: TaskRow = {
  ...task, id: "t-sub", title: "Verify the tags on rows without email", parent_task_id: task.id, delegate_agent_id: "a-lead", state: "working",
  review_state: "none", review_rounds: 0, active_run_id: "lead-run", last_activity_at: minutesAgo(1),
};

const base: TaskCardData = {
  kind: "task", task, run: null, approval: null, artifact, review, brief, activities,
  subtasks: [{ task: subtask, run: { ...run, id: "lead-run", task_id: "t-sub", agent_id: "a-lead", status: "running" }, agent_name: "Lead" }],
  agents: [
    { id: "a-worker", name: "Codex worker", role: "worker", capabilities: { continue: true } },
    { id: "a-lead", name: "Lead", role: "lead", capabilities: { continue: true, events: true } },
  ],
  app_url: APP_URL,
};

const list: WaitingListData = {
  kind: "waiting",
  app_url: APP_URL,
  items: [
    { task_id: task.id, title: task.title, state: "input_required", review_state: "none", waiting_on: "human", reason: "approval", row_page_id: "row1", agent_name: "Codex worker", last_activity_at: minutesAgo(1), approval: { id: actionApproval.id, kind: "action", action: "send_email", question: actionApproval.question, options: actionApproval.options, expires_at: actionApproval.expires_at }, url: `${APP_URL}/p/row1?task=${task.id}` },
    { task_id: "t-q", title: "Draft the October newsletter", state: "input_required", review_state: "none", waiting_on: "human", reason: "input", row_page_id: "row2", agent_name: "Claude Code", last_activity_at: minutesAgo(12), approval: { id: "ap-q2", kind: "elicitation", action: null, question: "Formal or casual tone?", options: ["respond"], expires_at: inHours(60) }, url: `${APP_URL}/p/row2?task=t-q` },
    { task_id: "t-r", title: "Migrate the pricing page", state: "ready_for_review", review_state: "approved", waiting_on: null, reason: "review", row_page_id: "row3", agent_name: "Lead", last_activity_at: minutesAgo(40), approval: null, url: `${APP_URL}/p/row3?task=t-r` },
  ],
};

export function mockCard(scenario: string): CardData {
  switch (scenario) {
    case "handover":
      return { ...base, continuity: { resume: true, checkpoint: { seq: 12, created_at: minutesAgo(5), harness: "claude_code", next_step: "Email the team", handover: true } },
        activities: [...activities, { id: "ac-handover", task_id: task.id, run_id: "run-2", seq: 13, type: "handover",
          body: { from_harness: "claude_code", to_harness: "codex", summary: "1 approval pending." }, ephemeral: false,
          author_type: "agent", author_id: "a-worker", created_at: minutesAgo(4) }] };
    case "approval":
      return { ...base, task: { ...task, state: "input_required", waiting_on: "human", active_run_id: run.id }, run, approval: actionApproval };
    case "question":
      return { ...base, task: { ...task, state: "input_required", waiting_on: "human", active_run_id: run.id }, run, approval: question };
    case "done":
      return { ...base, task: { ...task, state: "done", acceptance: "accepted", closed_at: minutesAgo(1), closed_by: "u1" } };
    case "list":
      return list;
    default:
      return base;
  }
}

const ok = (structured: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured });
const fail = (code: string, message: string, detail: unknown = null): ToolResult => ({
  isError: true, content: [{ type: "text", text: `Error ${code}: ${message}` }], structuredContent: { code, message, detail },
});

// Pretends to be the server: writes change the fake task and come back as a fresh card.
export function mockActions(scenario: string): CardActions {
  let current: TaskCardData = (() => {
    const data = mockCard(scenario);
    return data.kind === "task" ? data : (mockCard("approval") as TaskCardData);
  })();
  const denied = scenario === "denied";
  return {
    async callTool(name, args) {
      await new Promise((r) => setTimeout(r, 300));
      switch (name) {
        case "get_task":
          return ok(current as unknown as Record<string, unknown>);
        case "send_message":
          current = { ...current, task: { ...current.task, state: current.task.state === "done" ? "queued" : current.task.state, last_activity_at: new Date().toISOString() },
            activities: [...current.activities, { id: `ac${current.activities.length + 1}`, task_id: current.task.id, run_id: null, seq: current.activities.length + 1, type: "prompt", body: { text: String(args.body), signal: String(args.signal) }, ephemeral: false, author_type: "human", author_id: "u1", created_at: new Date().toISOString() }] };
          return ok({ activity_id: "ac-new", delivery: "queued" });
        case "decide_approval":
          if (denied && current.approval?.kind === "action" && (args.decision === "approve" || args.decision === "edit")) {
            return fail("direct_session_required", "This needs the person to act from the app directly.", { url: `${APP_URL}/p/row1?task=${task.id}#approval-${current.approval.id}` });
          }
          current = { ...current, task: { ...current.task, state: "working", waiting_on: null }, approval: null };
          return ok({ status: "decided", ...current });
        case "close_task":
          current = { ...current, task: { ...current.task, state: "done", acceptance: args.acceptance as TaskRow["acceptance"], closed_at: new Date().toISOString() }, approval: null, run: null };
          return ok({ task_state: "done", ...current });
        case "review_task":
          current = { ...current, review: { ...review, id: "rev-2", reviewer_type: "human", reviewer_id: "u1", verdict: args.verdict as ReviewRow["verdict"], findings: args.findings as ReviewRow["findings"], created_at: new Date().toISOString() }, task: { ...current.task, state: args.verdict === "approved" ? "ready_for_review" : "working", review_state: args.verdict === "approved" ? "approved" : "changes_requested" } };
          return ok({ review_id: "rev-2", task_state: current.task.state, rounds: 2 });
        default:
          return fail("unknown_tool", `Unknown tool: ${name}`);
      }
    },
    openLink(url) {
      window.open(url, "_blank", "noopener");
    },
  };
}
