import { create } from "zustand";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";
import { byId, learningRpc, liveRows, mergeRow } from "@/lib/agentLive";

// Non-persisted store of the lessons of a workspace, kept live through the Realtime channel `agent-lessons-<workspace>`.
// Every change goes through an RPC: the server decides.

export type LessonStatus = "proposed" | "accepted" | "dismissed" | "superseded" | "retired";
export type LessonScopeKind = "context" | "page" | "workspace";

export interface LessonRow {
  id: string;
  workspace_id: string;
  status: LessonStatus;
  body: string;
  example: string;
  scope: LessonScopeKind;
  scope_page_id: string | null;
  scope_context_id: string | null;
  source_kind: "review" | "feedback" | "rejection" | "person";
  source_task_id: string | null;
  source_text: string;
  decided_at: string | null;
  created_at: string;
}

export interface LessonScope {
  scope: LessonScopeKind;
  label: string;
  page_id?: string;
  context_id?: string;
}

export interface LessonStat {
  lesson_id: string;
  delivered: number;
  cited: number;
  corrected_after: number;
  before: { tasks: number; first_pass: number };
  after: { tasks: number; first_pass: number };
}

export type LessonDecision = "accept" | "dismiss";

interface LessonsState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  lessons: Record<string, LessonRow>;
  load: (workspaceId: string) => Promise<void>;
  subscribe: (workspaceId: string) => () => void;
}

const channel = liveRows("agent-lessons");

export const useAgentLessons = create<LessonsState>()((set, get) => ({
  status: "idle",
  error: null,
  lessons: {},

  async load(workspaceId) {
    const client = getAgentClient();
    if (!client) return;
    set({ status: "loading", error: null });
    const { data, error } = await client.from("lessons").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(500);
    if (error) {
      set({ status: "error", error: agentErrorMessage(error) });
      return;
    }
    set({ status: "ready", lessons: byId(data as LessonRow[]) });
  },

  subscribe(workspaceId) {
    return channel.subscribe(workspaceId, {
      lessons: (payload) => set({ lessons: mergeRow(get().lessons, payload) }),
    }, () => void get().load(workspaceId));
  },
}));

// Selectors take the record, not the store: a selector that builds an array on every call would re-render forever.

export function proposedLessons(lessons: Record<string, LessonRow>): LessonRow[] {
  return Object.values(lessons).filter((l) => l.status === "proposed").sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function acceptedLessons(lessons: Record<string, LessonRow>): LessonRow[] {
  return Object.values(lessons).filter((l) => l.status === "accepted").sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""));
}

export function proposalsOfTask(lessons: Record<string, LessonRow>, taskId: string): LessonRow[] {
  return proposedLessons(lessons).filter((l) => l.source_task_id === taskId);
}

const MESSAGES: Record<string, string> = {
  direct_session_required: "Open the workspace to decide this: a chat session cannot.",
  owner_only: "Only the workspace owner can apply a lesson to the whole workspace.",
  lesson_already_decided: "Someone already decided this lesson.",
};
const rpc = <T>(name: string, args: Record<string, unknown>) => learningRpc<T>(name, args, MESSAGES);

export const lessonScopes = (taskId: string) => rpc<LessonScope[]>("lesson_scopes", { p_task_id: taskId });
export const lessonStats = (workspaceId: string) => rpc<LessonStat[]>("lesson_stats", { p_workspace_id: workspaceId });

export function decideLesson(id: string, decision: LessonDecision, edits: { text?: string; example?: string; scope?: LessonScope } = {}) {
  return rpc("decide_lesson", { p_lesson_id: id, p_decision: decision, p_text: edits.text ?? null, p_example: edits.example ?? null,
    p_scope: edits.scope?.scope ?? null, p_scope_page_id: edits.scope?.page_id ?? null });
}

export const reviseLesson = (id: string, text: string, example: string) =>
  rpc("revise_lesson", { p_lesson_id: id, p_text: text, p_example: example });

export const retireLesson = (id: string) => rpc("retire_lesson", { p_lesson_id: id });
