import { create } from "zustand";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";
import type { Acceptance, RunStatus, TaskState } from "@/lib/agentState";

// Non-persisted store of the agent task model for one workspace: tasks, runs,
// approvals, reviews and artifacts by id, kept live through Realtime.
// Writes go through the control RPCs in lib/agentActions.ts.

export interface TaskRow {
  id: string;
  workspace_id: string;
  context_id: string;
  db_page_id: string | null;
  row_page_id: string;
  title: string;
  delegate_agent_id: string | null;
  owner_user_id: string;
  parent_task_id: string | null;
  depends_on_task_ids: string[];
  state: TaskState;
  review_state: "none" | "pending" | "approved" | "changes_requested" | "outdated";
  acceptance: Acceptance;
  waiting_on: "human" | "lead" | "agent" | null;
  brief_version: number;
  brief_stale: boolean;
  active_run_id: string | null;
  review_rounds: number;
  max_review_rounds: number;
  cost_usd: number;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

export interface RunRow {
  id: string;
  task_id: string;
  agent_id: string;
  harness: string;
  brief_version: number;
  status: RunStatus;
  stop_requested_at: string | null;
  stop_acked_at: string | null;
  last_signal_at: string;
  stale_at: string | null;
  waiting_on_task_id: string | null;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  cost_usd: number;
  cost_kind: "measured" | "estimated" | "unknown";
  error_message: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface ApprovalRow {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: "action" | "elicitation" | "plan" | "escalation";
  action: string | null;
  params: Record<string, unknown>;
  artifact_version: number | null;
  question: string;
  options: ("approve" | "reject" | "edit" | "respond" | "ignore")[];
  status: "pending" | "decided" | "consumed" | "expired" | "cancelled";
  decision: string | null;
  response: unknown;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface ReviewRow {
  id: string;
  task_id: string;
  run_id: string | null;
  reviewer_type: "human" | "agent";
  reviewer_id: string;
  artifact_id: string | null;
  artifact_version: number;
  brief_version: number;
  verdict: "approved" | "changes_requested" | "blocked";
  findings: { criterion_id: string; status: "verified" | "not_found" | "contradicted" | "unverified"; note?: string; evidence_ref?: string }[];
  evidence: { kind: string; ref: string; hash?: string }[];
  outdated_by: "artifact" | "brief" | null;
  outdated_at: string | null;
  created_at: string;
}

export interface ArtifactRow {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: "page" | "file" | "diff" | "query" | "image" | "external";
  ref: string;
  version: number;
  page_revision: number | null;
  title: string;
  satisfies: string[];
  author_type: "human" | "agent";
  author_id: string;
  superseded_by: string | null;
  created_at: string;
}

export interface BriefRow {
  task_id: string;
  version: number;
  objective: string;
  constraints: string;
  done_when: { id: string; text: string; check: "human" | "deterministic" | "lead"; command?: string }[];
  decisions: { at: string; by: string; text: string }[];
  sources: { kind: "page" | "url" | "artifact"; ref: string; trust: "internal" | "external" }[];
  open_questions: string[];
  next_step: string;
  policies: Record<string, unknown>;
  author_type: "human" | "agent";
  created_at: string;
}

export interface ActivityRow {
  id: string;
  task_id: string;
  run_id: string | null;
  seq: number;
  type: "thought" | "action" | "elicitation" | "response" | "error" | "prompt";
  body: Record<string, unknown>;
  ephemeral: boolean;
  author_type: "human" | "agent" | "system";
  author_id: string;
  created_at: string;
}

type ById<T> = Record<string, T>;

export interface AgentTasksState {
  workspaceId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  tasks: ById<TaskRow>;
  runs: ById<RunRow>;
  approvals: ById<ApprovalRow>;
  reviews: ById<ReviewRow>;
  artifacts: ById<ArtifactRow>;
  briefs: ById<BriefRow>; // key `${task_id}:${version}`
  activities: ById<ActivityRow[]>; // by task id, ordered by seq (loaded on demand)
  load: (workspaceId: string) => Promise<void>;
  subscribe: (workspaceId: string) => () => void;
  loadActivities: (taskId: string) => Promise<void>;
  loadBriefs: (taskId: string) => Promise<void>;
}

const TABLES = ["agent_tasks", "agent_runs", "agent_approvals", "agent_reviews", "agent_artifacts"] as const;
type Table = (typeof TABLES)[number];
const KEY: Record<Table, keyof Pick<AgentTasksState, "tasks" | "runs" | "approvals" | "reviews" | "artifacts">> = {
  agent_tasks: "tasks",
  agent_runs: "runs",
  agent_approvals: "approvals",
  agent_reviews: "reviews",
  agent_artifacts: "artifacts",
};

function index<T extends { id: string }>(rows: T[] | null | undefined): ById<T> {
  const out: ById<T> = {};
  for (const r of rows ?? []) out[r.id] = r;
  return out;
}

let channel: RealtimeChannel | null = null;

export const useAgentTasks = create<AgentTasksState>()((set, get) => ({
  workspaceId: null,
  status: "idle",
  error: null,
  tasks: {},
  runs: {},
  approvals: {},
  reviews: {},
  artifacts: {},
  briefs: {},
  activities: {},

  async load(workspaceId) {
    const client = getAgentClient();
    if (!client) return;
    set({ status: "loading", error: null, workspaceId });
    try {
      const [tasks, runs, approvals, reviews, artifacts] = await Promise.all(
        TABLES.map((t) => client.from(t).select("*").eq("workspace_id", workspaceId)),
      );
      const failed = [tasks, runs, approvals, reviews, artifacts].find((r) => r.error);
      if (failed?.error) throw new Error(agentErrorMessage(failed.error));
      set({
        status: "ready",
        tasks: index(tasks.data as TaskRow[]),
        runs: index(runs.data as RunRow[]),
        approvals: index(approvals.data as ApprovalRow[]),
        reviews: index(reviews.data as ReviewRow[]),
        artifacts: index(artifacts.data as ArtifactRow[]),
      });
    } catch (e) {
      set({ status: "error", error: agentErrorMessage(e) });
    }
  },

  subscribe(workspaceId) {
    const client = getAgentClient();
    if (!client) return () => {};
    if (channel) {
      void client.removeChannel(channel);
      channel = null;
    }
    const ch = client.channel(`agents-${workspaceId}`);
    for (const table of TABLES) {
      ch.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `workspace_id=eq.${workspaceId}` },
        (payload: RealtimePostgresChangesPayload<{ id: string }>) => {
          const key = KEY[table];
          const current = get()[key] as ById<{ id: string }>;
          if (payload.eventType === "DELETE") {
            const id = payload.old.id;
            if (!id) return;
            const next = { ...current };
            delete next[id];
            set({ [key]: next } as Partial<AgentTasksState>);
          } else {
            const row = payload.new;
            set({ [key]: { ...current, [row.id]: row } } as Partial<AgentTasksState>);
          }
        },
      );
    }
    ch.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "agent_activities", filter: `workspace_id=eq.${workspaceId}` },
      (payload: RealtimePostgresChangesPayload<ActivityRow>) => {
        const row = payload.new as ActivityRow;
        if (!row?.task_id) return;
        const list = get().activities[row.task_id];
        if (!list) return; // not loaded for this task; loadActivities fetches on demand
        if (list.some((a) => a.id === row.id)) return;
        set({ activities: { ...get().activities, [row.task_id]: [...list, row].sort((a, b) => a.seq - b.seq) } });
      },
    );
    ch.subscribe();
    channel = ch;
    void get().load(workspaceId);
    return () => {
      if (channel === ch) channel = null;
      void client.removeChannel(ch);
    };
  },

  async loadActivities(taskId) {
    const client = getAgentClient();
    if (!client) return;
    const { data, error } = await client.from("agent_activities").select("*").eq("task_id", taskId).order("seq");
    if (error) return;
    set({ activities: { ...get().activities, [taskId]: (data ?? []) as ActivityRow[] } });
  },

  async loadBriefs(taskId) {
    const client = getAgentClient();
    if (!client) return;
    const { data, error } = await client.from("task_briefs").select("*").eq("task_id", taskId).order("version");
    if (error) return;
    const next = { ...get().briefs };
    for (const b of (data ?? []) as BriefRow[]) next[`${b.task_id}:${b.version}`] = b;
    set({ briefs: next });
  },
}));

// Selectors.

const OPEN: TaskState[] = ["queued", "working", "input_required", "ready_for_review"];

export function taskForPage(state: AgentTasksState, pageId: string): TaskRow | null {
  const rows = Object.values(state.tasks).filter((t) => t.row_page_id === pageId);
  if (rows.length === 0) return null;
  const open = rows.find((t) => OPEN.includes(t.state));
  return open ?? rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

export function waitingOnYou(state: AgentTasksState): TaskRow[] {
  return Object.values(state.tasks)
    .filter((t) => t.state === "input_required" && (t.waiting_on === "human" || t.waiting_on === null))
    .sort((a, b) => (b.last_activity_at ?? b.updated_at).localeCompare(a.last_activity_at ?? a.updated_at));
}

export function pendingApprovalFor(state: AgentTasksState, taskId: string): ApprovalRow | null {
  return Object.values(state.approvals).find((a) => a.task_id === taskId && a.status === "pending") ?? null;
}

export function activeRunFor(state: AgentTasksState, task: TaskRow): RunRow | null {
  return task.active_run_id ? (state.runs[task.active_run_id] ?? null) : null;
}

export function currentArtifactFor(state: AgentTasksState, taskId: string): ArtifactRow | null {
  const rows = Object.values(state.artifacts).filter((a) => a.task_id === taskId && !a.superseded_by);
  if (rows.length === 0) return null;
  return rows.sort((a, b) => b.version - a.version || b.created_at.localeCompare(a.created_at))[0];
}

export function latestReviewFor(state: AgentTasksState, taskId: string): ReviewRow | null {
  const rows = Object.values(state.reviews).filter((r) => r.task_id === taskId);
  if (rows.length === 0) return null;
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

export function currentBriefFor(state: AgentTasksState, task: TaskRow): BriefRow | null {
  return state.briefs[`${task.id}:${task.brief_version}`] ?? null;
}
