// The decisions home: what waits on the signed-in person, what agents are doing for them,
// what is ready for their review and what closed today. Pure: built from the live task rows.
import { describeApproval } from "@/lib/agentApprovalText";
import { approvalPath, taskPath } from "@/lib/agentLinks";
import { RUN_STATUS_LABEL, acceptanceLabel, isTerminal } from "@/lib/agentState";
import type { ApprovalRow, RunRow, TaskRow } from "@/lib/agentTasks";

export type HomeSection = "waiting" | "working" | "review" | "done";
export interface HomeItem {
  key: string; section: HomeSection; taskId: string; rowPageId: string; title: string; detail: string;
  agentName: string | null; href: string; at: string; nonBlocking: boolean; stale: boolean;
}
export type DecisionsHomeData = Record<HomeSection, HomeItem[]>;
export interface HomeInput {
  tasks: TaskRow[]; approvals: ApprovalRow[]; runs: Record<string, RunRow>;
  agents: { id: string; name: string; role?: string }[]; userId: string | null; now: number;
}

export function startOfLocalDay(now: number): number {
  const date = new Date(now);
  return date.setHours(0, 0, 0, 0);
}

export function buildDecisionsHome({ tasks, approvals, runs, agents, userId, now }: HomeInput): DecisionsHomeData {
  const home: DecisionsHomeData = { waiting: [], working: [], review: [], done: [] };
  if (!userId) return home;
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const byAgent = new Map(agents.map((a) => [a.id, a]));
  const waitingTasks = new Set<string>();
  const midnight = startOfLocalDay(now);
  const item = (t: TaskRow, section: HomeSection, detail: string): HomeItem => ({
    key: `task:${t.id}`, section, taskId: t.id, rowPageId: t.row_page_id, title: t.title || "Untitled task", detail,
    agentName: byAgent.get(t.delegate_agent_id ?? "")?.name ?? null, href: taskPath(t.row_page_id, t.id),
    at: t.last_activity_at ?? t.updated_at, nonBlocking: false, stale: false,
  });
  for (const ap of approvals) {
    const t = byTask.get(ap.task_id);
    if (ap.status !== "pending" || !t || t.owner_user_id !== userId || isTerminal(t.state)) continue;
    const detail = ap.kind === "action"
      ? describeApproval(ap.action, ap.params, { artifactVersion: ap.artifact_version }).what
      : ap.question || "Waiting for you";
    home.waiting.push({ ...item(t, "waiting", detail), key: `approval:${ap.id}`, at: ap.created_at,
      href: approvalPath(t.row_page_id, t.id, ap.id), nonBlocking: ap.blocking === false });
    waitingTasks.add(t.id);
  }
  for (const t of tasks) {
    if (t.owner_user_id !== userId) continue;
    if (t.state === "input_required" && !waitingTasks.has(t.id) && t.waiting_on !== "lead" && t.waiting_on !== "agent") {
      home.waiting.push({ ...item(t, "waiting", "Waiting for you"), at: t.updated_at });
    }
    if (t.state === "working") {
      const run = runs[t.active_run_id ?? ""];
      const stale = !!run?.stale_at;
      home.working.push({ ...item(t, "working", stale ? "No signals lately" : run ? RUN_STATUS_LABEL[run.status] : "Working"), stale });
    }
    if (t.state === "ready_for_review") {
      const parent = byTask.get(t.parent_task_id ?? "");
      if (byAgent.get(parent?.delegate_agent_id ?? "")?.role !== "lead") {
        home.review.push({ ...item(t, "review", t.review_state === "outdated" ? "Review outdated" : "Deliverable ready"), at: t.updated_at });
      }
    }
    if (isTerminal(t.state)) {
      const at = t.state === "done" ? t.closed_at : t.closed_at ?? t.updated_at;
      if (at && Date.parse(at) >= midnight) {
        const detail = t.state === "failed" ? "Failed" : t.state === "cancelled" ? "Stopped" : acceptanceLabel(t.acceptance);
        home.done.push({ ...item(t, "done", detail), at });
      }
    }
  }
  home.waiting.sort((a, b) => Number(a.nonBlocking) - Number(b.nonBlocking) || Date.parse(a.at) - Date.parse(b.at));
  for (const section of [home.working, home.review, home.done]) section.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return home;
}
