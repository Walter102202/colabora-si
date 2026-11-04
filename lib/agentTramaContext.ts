import { taskForPage, type TaskRow } from "@/lib/agentTasks";
import { create } from "zustand";

export interface ActiveProgressContext { owner: string; workspaceId: string; userId: string; databaseId: string; pageId: string; }
// Transient visible-surface context. A retained URL alone is not evidence that
// Progress is active (the person may now be looking at Board or Table).
export const useAgentProgressContext = create<{ context: ActiveProgressContext | null }>(() => ({ context: null }));

export const TRAMA_TASK_DRAFT_EVENT = "colabora:trama-task-draft";
export interface TramaTaskDraft { workspaceId: string; taskId: string; pageId: string; prompt: string; }

// Opening a contextual draft never sends a message or starts agent work.
export function openTramaTaskDraft(detail: TramaTaskDraft): void {
  window.dispatchEvent(new CustomEvent<TramaTaskDraft>(TRAMA_TASK_DRAFT_EVENT, { detail }));
}

export function progressTramaTask(pageId: string | undefined, search: string, tasks: Record<string, TaskRow>, workspaceId: string): TaskRow | null {
  const params = new URLSearchParams(search);
  const rowPageId = params.get("progressRow");
  if (!pageId || !rowPageId || params.get("taskLayout") === "table" || params.has("peek")) return null;
  const scoped = Object.fromEntries(Object.entries(tasks).filter(([, task]) => task.workspace_id === workspaceId && task.db_page_id === pageId));
  return taskForPage({ tasks: scoped }, rowPageId);
}
