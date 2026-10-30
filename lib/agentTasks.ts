import { create } from "zustand";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";
import type { CiCheckRow } from "@/lib/agentCi";
import type { Acceptance, RunStatus, TaskState } from "@/lib/agentState";

// Non-persisted store of the agent task model for one workspace: tasks, runs,
// approvals, reviews and artifacts by id, kept live through Realtime.
// Writes go through the control RPCs in lib/agentActions.ts.

export interface TaskRow {
  request_kind?: "fill" | "rewrite" | null;
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
  // false: asked with request_input blocking false; the task keeps working.
  blocking?: boolean;
  // Set when the autonomy level or the brief approved it without a person.
  auto_by?: "preset" | "brief" | null;
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
  done_when: { id: string; text: string; check: "human" | "deterministic" | "lead" | "ci"; command?: string }[];
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
  type: "thought" | "action" | "elicitation" | "response" | "error" | "prompt" | "checkpoint" | "handover";
  body: Record<string, unknown>;
  ephemeral: boolean;
  author_type: "human" | "agent" | "system";
  author_id: string;
  created_at: string;
}

export interface EnvironmentResource {
  kind: "ports" | "stack" | "worktree" | "branch" | "migration";
  value: string;
  status: "held" | "releasing" | "released";
}

type ById<T> = Record<string, T>;
type Client = NonNullable<ReturnType<typeof getAgentClient>>;
type ClosedCursor = { updated_at: string; id: string };

export interface AgentTasksState {
  workspaceId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  tasks: ById<TaskRow>; // open tasks plus the closed pages loaded so far
  runs: ById<RunRow>; // the most recent runs of the workspace plus every run of a loaded task
  approvals: ById<ApprovalRow>; // pending approvals plus what Realtime delivers
  reviews: ById<ReviewRow>; // per task, loaded with the detail
  artifacts: ById<ArtifactRow>; // per task, loaded with the detail
  briefs: ById<BriefRow>; // key `${task_id}:${version}`
  ciChecks: ById<CiCheckRow[]>;
  environments: ById<EnvironmentResource[]>;
  activities: ById<ActivityRow[]>; // by task id, ordered by seq (loaded on demand)
  closedCursor: ClosedCursor | null; // keyset of the oldest closed task loaded
  closedExhausted: boolean;
  load: (workspaceId: string) => Promise<void>;
  loadMoreClosed: () => Promise<void>;
  loadTask: (taskId: string) => Promise<void>;
  loadTaskDetail: (taskId: string) => Promise<void>;
  refreshCiChecks: (workspaceId?: string) => Promise<void>;
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

const OPEN: TaskState[] = ["queued", "working", "input_required", "ready_for_review"];
const CLOSED: TaskState[] = ["done", "failed", "cancelled"];

// Page sizes. Open tasks and runs take a plain limit because their cardinality is
// that of the live work; closed tasks grow forever and page by keyset.
export const CLOSED_PAGE_SIZE = 50;
export const ACTIVITIES_PAGE_SIZE = 200;
const OPEN_LIMIT = 500;
const RUNS_LIMIT = 500;
const REVIEWS_LIMIT = 20;
let detailRequestSequence = 0;
const detailRequests = new Map<string, number>();

/** Merges a page of rows into a map by id: rows outside the page stay, rows inside it are replaced. */
export function mergeRows<T extends { id: string }>(current: ById<T>, rows: T[] | null | undefined): ById<T> {
  const out: ById<T> = { ...current };
  for (const r of rows ?? []) out[r.id] = r;
  return out;
}

/** Merges a page of activities into a task's list: deduped by id, ordered by seq. */
export function mergeActivities(current: ActivityRow[] | undefined, rows: ActivityRow[]): ActivityRow[] {
  const byId = new Map<string, ActivityRow>();
  for (const a of current ?? []) byId.set(a.id, a);
  for (const a of rows) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

// Closed tasks, newest first, by (updated_at, id) so that a page boundary between two
// rows with the same timestamp is stable; `cursor` is the last row of the previous page.
function closedTasksQuery(client: Client, workspaceId: string, cursor: ClosedCursor | null) {
  let q = client.from("agent_tasks").select("*").eq("workspace_id", workspaceId).in("state", CLOSED);
  if (cursor) q = q.or(`updated_at.lt.${cursor.updated_at},and(updated_at.eq.${cursor.updated_at},id.lt.${cursor.id})`);
  return q.order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(CLOSED_PAGE_SIZE);
}

function cursorAfter(rows: TaskRow[]): ClosedCursor | null {
  const last = rows[rows.length - 1];
  return last ? { updated_at: last.updated_at, id: last.id } : null;
}

let channel: RealtimeChannel | null = null;
let channelWorkspace: string | null = null;
let subscribers = 0;

// supabase-js returns the registered channel for a topic that still exists; after an unawaited
// removeChannel that instance is already subscribed and `.on` would throw. Drop it from the registry first.
function dropStaleChannel(client: ReturnType<typeof getAgentClient>, topic: string): void {
  if (!client) return;
  const full = `realtime:${topic}`;
  if (client.realtime.channels.some((c) => c.topic === full)) {
    client.realtime.channels = client.realtime.channels.filter((c) => c.topic !== full);
  }
}


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
  ciChecks: {},
  environments: {},
  activities: {},
  closedCursor: null,
  closedExhausted: false,

  // The first page of a workspace: open tasks, the latest closed ones, the most recent
  // runs and the pending approvals. Reviews and artifacts arrive with each task's detail.
  async load(workspaceId) {
    const client = getAgentClient();
    if (!client) return;
    const reset = get().workspaceId === workspaceId
      ? {}
      : { tasks: {}, runs: {}, approvals: {}, reviews: {}, artifacts: {}, ciChecks: {}, environments: {}, closedCursor: null, closedExhausted: false };
    set({ status: "loading", error: null, workspaceId, ...reset });
    try {
      const [open, closed, runs, approvals] = await Promise.all([
        client.from("agent_tasks").select("*").eq("workspace_id", workspaceId).in("state", OPEN).limit(OPEN_LIMIT),
        closedTasksQuery(client, workspaceId, null),
        client.from("agent_runs").select("*").eq("workspace_id", workspaceId).order("started_at", { ascending: false }).limit(RUNS_LIMIT),
        client.from("agent_approvals").select("*").eq("workspace_id", workspaceId).eq("status", "pending"),
      ]);
      const failed = [open, closed, runs, approvals].find((r) => r.error);
      if (failed?.error) throw new Error(agentErrorMessage(failed.error));
      const closedRows = (closed.data ?? []) as TaskRow[];
      const s = get();
      set({
        status: "ready",
        tasks: mergeRows(s.tasks, [...((open.data ?? []) as TaskRow[]), ...closedRows]),
        runs: mergeRows(s.runs, runs.data as RunRow[]),
        approvals: mergeRows(s.approvals, approvals.data as ApprovalRow[]),
        closedCursor: cursorAfter(closedRows),
        closedExhausted: closedRows.length < CLOSED_PAGE_SIZE,
      });
    } catch (e) {
      set({ status: "error", error: agentErrorMessage(e) });
    }
  },

  async loadMoreClosed() {
    const client = getAgentClient();
    const { workspaceId, closedCursor, closedExhausted } = get();
    if (!client || !workspaceId || !closedCursor || closedExhausted) return;
    const { data, error } = await closedTasksQuery(client, workspaceId, closedCursor);
    if (error) return;
    const rows = (data ?? []) as TaskRow[];
    set({
      tasks: mergeRows(get().tasks, rows),
      closedCursor: cursorAfter(rows) ?? closedCursor,
      closedExhausted: rows.length < CLOSED_PAGE_SIZE,
    });
  },

  // One task after an action on it: the row, all of its runs (blocks edited by closed runs
  // still name them) and its pending approvals. Approvals of the task that are no longer
  // pending (decided, expired or cancelled with the task) leave the store.
  async loadTask(taskId) {
    const client = getAgentClient();
    if (!client) return;
    const [task, runs, approvals] = await Promise.all([
      client.from("agent_tasks").select("*").eq("id", taskId),
      client.from("agent_runs").select("*").eq("task_id", taskId),
      client.from("agent_approvals").select("*").eq("task_id", taskId).eq("status", "pending"),
    ]);
    if (task.error || runs.error || approvals.error) return;
    const s = get();
    const pending = (approvals.data ?? []) as ApprovalRow[];
    const stillPending = new Set(pending.map((a) => a.id));
    const kept: ById<ApprovalRow> = {};
    for (const a of Object.values(s.approvals)) {
      if (a.task_id === taskId && a.status === "pending" && !stillPending.has(a.id)) continue;
      kept[a.id] = a;
    }
    set({
      tasks: mergeRows(s.tasks, task.data as TaskRow[]),
      runs: mergeRows(s.runs, runs.data as RunRow[]),
      approvals: mergeRows(kept, pending),
    });
  },

  // What the panel shows beyond the row: briefs, artifacts and the latest reviews.
  async loadTaskDetail(taskId) {
    const client = getAgentClient();
    if (!client) return;
    const request = ++detailRequestSequence;
    detailRequests.set(taskId, request);
    const workspaceId = get().workspaceId;
    const [, artifacts, reviews, environment] = await Promise.all([
      get().loadBriefs(taskId),
      client.from("agent_artifacts").select("*").eq("task_id", taskId),
      client.from("agent_reviews").select("*").eq("task_id", taskId).order("created_at", { ascending: false }).limit(REVIEWS_LIMIT),
      client.from("agent_resources").select("kind,value,status").eq("task_id", taskId).neq("status", "released").order("created_at", { ascending: true }),
    ]);
    const task = get().tasks[taskId];
    const brief = task ? get().briefs[`${taskId}:${task.brief_version}`] : undefined;
    const ci = brief?.done_when.some((c) => c.check === "ci")
      ? await client.rpc("task_ci_status", { p_task_id: taskId }) : null;
    const s = get();
    if (s.workspaceId !== workspaceId || detailRequests.get(taskId) !== request) return;
    detailRequests.delete(taskId);
    set({
      ciChecks: { ...s.ciChecks, [taskId]: ci && !ci.error ? (ci.data ?? []) as CiCheckRow[] : [] },
      ...(environment.error ? {} : { environments: { ...s.environments, [taskId]: (environment.data ?? []) as EnvironmentResource[] } }),
      ...(artifacts.error ? {} : { artifacts: mergeRows(s.artifacts, artifacts.data as ArtifactRow[]) }),
      ...(reviews.error ? {} : { reviews: mergeRows(s.reviews, reviews.data as ReviewRow[]) }),
    });
  },

  async refreshCiChecks(workspaceId) {
    const s = get();
    const ids = Object.keys(s.ciChecks).filter((id) => !workspaceId || s.tasks[id]?.workspace_id === workspaceId);
    set({ ciChecks: { ...s.ciChecks, ...Object.fromEntries(ids.map((id) => [id, []])) } });
    await Promise.all(ids.map((id) => get().loadTaskDetail(id).catch(() => {})));
  },

  // Reference counted: the first caller for a workspace opens the channel and loads the
  // rows; later callers share it; the channel closes when the last one releases.
  subscribe(workspaceId) {
    const client = getAgentClient();
    if (!client) return () => {};
    if (channel && channelWorkspace === workspaceId) {
      subscribers += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        subscribers -= 1;
        if (subscribers <= 0 && channel) {
          void client.removeChannel(channel);
          channel = null;
          channelWorkspace = null;
        }
      };
    }
    if (channel) {
      void client.removeChannel(channel);
      channel = null;
    }
    subscribers = 1;
    channelWorkspace = workspaceId;
    dropStaleChannel(client, `agents-${workspaceId}`);
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
          if (table === "agent_artifacts") {
            const artifact = (payload.eventType === "DELETE" ? current[payload.old.id ?? ""] : payload.new) as ArtifactRow | undefined;
            if (artifact?.task_id && Object.hasOwn(get().ciChecks, artifact.task_id)) {
              set({ ciChecks: { ...get().ciChecks, [artifact.task_id]: [] } });
              void get().loadTaskDetail(artifact.task_id).catch(() => {});
            }
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
        if (row.body?.ci) {
          set({ ciChecks: { ...get().ciChecks, [row.task_id]: [] } });
          void get().loadTaskDetail(row.task_id).catch(() => {});
        }
        const list = get().activities[row.task_id];
        if (!list) return; // not loaded for this task; loadActivities fetches on demand
        if (list.some((a) => a.id === row.id)) return;
        set({ activities: { ...get().activities, [row.task_id]: [...list, row].sort((a, b) => a.seq - b.seq) } });
      },
    );
    ch.subscribe();
    channel = ch;
    void get().load(workspaceId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscribers -= 1;
      if (channel !== ch) return; // replaced by a newer workspace channel
      if (subscribers <= 0) {
        channel = null;
        channelWorkspace = null;
        void client.removeChannel(ch);
      }
    };
  },

  // First call: the last ACTIVITIES_PAGE_SIZE activities of the task. Later calls: only
  // what is newer than the list already held, so a refresh after an action is one short read.
  async loadActivities(taskId) {
    const client = getAgentClient();
    if (!client) return;
    const current = get().activities[taskId];
    const base = client.from("agent_activities").select("*").eq("task_id", taskId);
    const { data, error } = current
      ? await base.gt("seq", current.reduce((max, a) => Math.max(max, a.seq), 0)).order("seq").limit(ACTIVITIES_PAGE_SIZE)
      : await base.order("seq", { ascending: false }).limit(ACTIVITIES_PAGE_SIZE);
    if (error) return;
    const activities = get().activities;
    set({ activities: { ...activities, [taskId]: mergeActivities(activities[taskId], (data ?? []) as ActivityRow[]) } });
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

export function taskForPage(state: AgentTasksState, pageId: string): TaskRow | null {
  const rows = Object.values(state.tasks).filter((t) => t.row_page_id === pageId && t.request_kind == null);
  if (rows.length === 0) return null;
  const open = rows.find((t) => OPEN.includes(t.state));
  return open ?? rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

export function waitingOnYou(state: AgentTasksState): TaskRow[] {
  return Object.values(state.tasks)
    .filter((t) => t.state === "input_required" && (t.waiting_on === "human" || t.waiting_on === null))
    .sort((a, b) => (b.last_activity_at ?? b.updated_at).localeCompare(a.last_activity_at ?? a.updated_at));
}

// The pending approval the panel shows for a task: the one a deep link names
// when it is pending here, otherwise the oldest (the order the chat card uses).
export function pendingApprovalFor(state: AgentTasksState, taskId: string, preferId: string | null = null): ApprovalRow | null {
  const pending = Object.values(state.approvals).filter((a) => a.task_id === taskId && a.status === "pending" && a.blocking !== false);
  const preferred = preferId ? pending.find((a) => a.id === preferId) : null;
  if (preferred) return preferred;
  return pending.sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
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

export function lastCheckpointFor(activities: ActivityRow[] | undefined): ActivityRow | null {
  return (activities ?? []).reduce<ActivityRow | null>((last, a) => a.type === "checkpoint" && (!last || a.seq > last.seq) ? a : last, null);
}
