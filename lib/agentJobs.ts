import type { AgentRow, AgentRole } from "@/lib/agentsStore";
import type { ConnectionRow } from "@/lib/agentConnect";
import { CONNECT_AGENT_NAMES } from "@/lib/agentConnectCatalog";
import type { TaskRow } from "@/lib/agentTasks";

export interface JobAgent { id: string; name: string; logo: string | null; role: AgentRole; }
export interface JobSentence { agentId: string; name: string; logo: string | null; text: string; isLead: boolean; }
export interface JobReadyData { lines: JobSentence[]; sayThis: string; readyNote: string; planText: string; waitingText: string; }
export const JOB_ACCESS_NOTE = "Choosing an agent gives it access to this database. It can see every job here, not only this one.";

export type JobTask = Pick<TaskRow, "state"> & Partial<Pick<TaskRow, "waiting_on" | "review_state" | "named_worker_ids" | "joined_worker_ids">>;
export const JOB_STATE_LABEL = {
  needs_lead: "Needs a Lead", ready: "Ready", writing: "Writing subtasks", waiting_workers: "Waiting for Workers",
  working: "Working", done: "Done", failed: "Failed", cancelled: "Cancelled", input_required: "Needs your decision", ready_for_review: "Ready to accept",
};
export const SUBTASK_STATE_LABEL = {
  pending: "Waiting on Lead", queued: "Planned", working: "Working", input_required: "Needs your decision",
  waiting_for_input: "Waiting for input", ready_for_review: "Ready for review", done: "Done", failed: "Failed", cancelled: "Cancelled",
};
export type JobState = keyof typeof JOB_STATE_LABEL;
export type WaitLabel = "You" | "Lead" | "Worker" | "Nobody";
export interface JobWaiting { label: WaitLabel; count: number; }

export function jobState(task: JobTask | null | undefined, subtasks: (JobTask | null)[]): JobState {
  if (!task) return "needs_lead";
  if (task.state === "done" || task.state === "failed" || task.state === "cancelled") return task.state;
  if (task.state === "queued") return "ready";
  if (task.state === "ready_for_review") return "ready_for_review";
  if (task.state === "working" && !subtasks.length) return "writing";
  if (subtasks.length && task.named_worker_ids?.some((id) => !task.joined_worker_ids?.includes(id))) return "waiting_workers";
  return subtasks.length ? "working" : task.state;
}

export function subtaskState(task: JobTask | null | undefined): keyof typeof SUBTASK_STATE_LABEL {
  if (!task) return "pending";
  return task.state === "input_required" && task.waiting_on && task.waiting_on !== "human" ? "waiting_for_input" : task.state;
}

export function subWait(task: JobTask | null | undefined): WaitLabel {
  if (!task) return "Lead";
  if (task.state === "input_required") return task.waiting_on === "human" ? "You" : task.waiting_on === "lead" ? "Lead" : "Worker";
  if (task.state === "ready_for_review") return task.review_state === "approved" ? "You" : "Lead";
  return task.state === "working" ? "Worker" : "Nobody";
}

export function jobWait(task: JobTask | null | undefined, subtasks: (JobTask | null)[]): JobWaiting {
  const state = jobState(task, subtasks);
  if (state === "needs_lead" || state === "ready") return { label: "You", count: 0 };
  if (state === "writing") return { label: "Lead", count: 0 };
  if (state === "waiting_workers") return { label: "Worker", count: 0 };
  if (state === "done" || state === "failed" || state === "cancelled") return { label: "Nobody", count: 0 };
  // One Accept settles a delivered job and the deliveries under it, so together they count once.
  const accepting = task?.state === "ready_for_review";
  const waits = (accepting ? subtasks.filter((sub) => sub?.state !== "ready_for_review") : subtasks).map(subWait);
  if (accepting) waits.push("You");
  else if (task?.state === "input_required") waits.push(subWait(task));
  const you = waits.filter((wait) => wait === "You").length, lead = waits.filter((wait) => wait === "Lead").length;
  return you ? { label: "You", count: you } : lead ? { label: "Lead", count: lead }
    : { label: waits.includes("Worker") ? "Worker" : "Nobody", count: 0 };
}

export function eligibleJobAgents(
  agents: Pick<AgentRow, "id" | "name" | "role" | "status" | "is_platform" | "revoked_at">[],
  connections: Pick<ConnectionRow, "agent_id" | "verified_at">[],
): JobAgent[] {
  return agents.filter((agent) => !agent.is_platform && !agent.revoked_at && agent.status === "enabled"
    // Agents added in Settings have no connection row; a connection still pending stays out.
    && !connections.some((connection) => connection.agent_id === agent.id && !connection.verified_at))
    .map((agent) => {
      const catalogId = Object.entries(CONNECT_AGENT_NAMES).find(([, name]) => name.toLowerCase() === agent.name.toLowerCase())?.[0];
      return { id: agent.id, name: agent.name, role: agent.role, logo: catalogId ? `/brand/agents/${catalogId}.svg` : null };
    });
}

export function jobAgentNames(names: string[]): string {
  return names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

export function jobReadyPanel({ title, lead, workers, subtaskCount, hasPlan }: {
  title: string; lead: JobAgent; workers: JobAgent[]; subtaskCount: number; hasPlan: boolean;
}): JobReadyData {
  const crew = workers.filter((agent, i) => agent.id !== lead.id && workers.findIndex((candidate) => candidate.id === agent.id) === i);
  return {
    lines: [
      { agentId: lead.id, name: lead.name, logo: lead.logo, isLead: true,
        text: `Work on ${title} as Lead` + (crew.length ? `, with ${jobAgentNames(crew.map((agent) => agent.name))} as ${crew.length > 1 ? "workers" : "worker"}` : "") },
      ...crew.map((agent) => ({ agentId: agent.id, name: agent.name, logo: agent.logo, isLead: false, text: `Work on ${title} as worker` })),
    ],
    sayThis: crew.length ? "Say this to each agent, in its own session." : "Say this to the Lead, in its own session.",
    waitingText: `Waiting for ${lead.name}. This page updates when it arrives.`,
    readyNote: `Nothing starts until ${lead.name} arrives. It ` + (subtaskCount ? "keeps your subtasks and writes the rest."
      : "writes the subtasks and " + (crew.length ? "shares them out." : "does them itself.")),
    planText: hasPlan ? "The plan is on this job’s page." : "The plan goes on this job’s page, or give it to the Lead in the chat.",
  };
}
