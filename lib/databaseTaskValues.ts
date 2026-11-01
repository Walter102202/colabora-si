import type { Database, DbProperty } from "@/lib/types";
import type { TaskRow } from "@/lib/agentTasks";
import type { AgentRow } from "@/lib/agentsStore";
import { JOB_STATE_LABEL, SUBTASK_STATE_LABEL, jobState, jobWait, subtaskState, subWait, type JobTask } from "@/lib/agentJobs";
type TaskValue = JobTask & Pick<TaskRow, "row_page_id" | "delegate_agent_id" | "parent_task_id" | "updated_at" | "request_kind"> & Partial<Pick<TaskRow, "brief_version">>;
type BriefValue = { done_when: { text: string }[] };

// Query-only cells; the source database keeps its rows and agent property types.
export function databaseTaskValues(database: Database, tasks: Record<string, TaskValue>, agents: Pick<AgentRow, "id" | "name" | "role">[], briefs: Record<string, BriefValue> = {}): Database {
  const hasAgentStatus = database.properties.some((p) => p.type === "agentStatus");
  const properties = database.properties.filter((p) => p.type === "agentStatus" || p.type === "agentDelegate" || (hasAgentStatus && ["Lead", "Waiting on", "Done when"].includes(p.name)));
  if (!properties.length) return database;
  const byPage = new Map<string, { id: string; task: TaskValue }>(), rowByPage = new Map(database.rows.map((row) => [row.pageId, row.id]));
  const terminal = (task: TaskValue) => ["done", "failed", "cancelled"].includes(task.state);
  for (const [id, task] of Object.entries(tasks)) {
    if (task.request_kind != null) continue;
    const previous = byPage.get(task.row_page_id)?.task;
    if (!previous || (terminal(previous) && !terminal(task)) || (terminal(previous) === terminal(task) && task.updated_at > previous.updated_at)) byPage.set(task.row_page_id, { id, task });
  }
  const rows = database.rows.map((row) => {
    const task = byPage.get(row.pageId)?.task;
    const parentRowId = task?.parent_task_id ? rowByPage.get(tasks[task.parent_task_id]?.row_page_id ?? "") : undefined;
    return { ...row, ...(parentRowId ? { parentRowId } : {}) };
  });
  return {
    ...database,
    properties: database.properties.map((p): DbProperty => p.type === "agentStatus"
      ? { ...p, type: "select", options: Object.entries({ ...SUBTASK_STATE_LABEL, ...JOB_STATE_LABEL }).map(([id, name]) => ({ id, name, color: "gray" })) }
      : p.type === "agentDelegate" || (hasAgentStatus && p.name === "Waiting on") ? { ...p, type: "text" } : p),
    rows: rows.map((row) => {
      const selected = byPage.get(row.pageId), task = selected?.task, cells = { ...row.cells };
      const leadTask = task?.parent_task_id ? tasks[task.parent_task_id] : task;
      const lead = agents.find((agent) => agent.id === leadTask?.delegate_agent_id && agent.role === "lead");
      const children = rows.filter((child) => child.parentRowId === row.id).map((child) => byPage.get(child.pageId)?.task ?? null);
      const waiting = row.parentRowId ? { label: subWait(task), count: 0 } : jobWait(task, children);
      for (const property of properties) {
        if (property.type === "agentStatus") cells[property.id] = row.parentRowId ? subtaskState(task) : jobState(task, children);
        else if (property.type === "agentDelegate") cells[property.id] = task?.delegate_agent_id ?? null;
        else if (property.name === "Waiting on") cells[property.id] = waiting.label + (waiting.count ? ` ${waiting.count}` : "");
        else if (property.name === "Done when") cells[property.id] = selected ? (briefs[`${selected.id}:${task?.brief_version}`]?.done_when ?? []).map((criterion) => criterion.text).join("; ") : row.cells[property.id] ?? "";
        else cells[property.id] = lead?.name ?? null;
      }
      return { ...row, cells };
    }),
  };
}

type QueryRow = { id: string; parentRowId?: string | null; cells: Record<string, unknown> };

export function waitingOnYouRows<R extends QueryRow>(rows: R[], statusId: string, waitingId: string) {
  return rows.filter((row) => row.parentRowId ? String(row.cells[waitingId]).startsWith("You") : ["needs_lead", "ready", "ready_for_review"].includes(String(row.cells[statusId])));
}

// One Accept settles a delivered job and what it delivered, so they count once.
export function waitingOnYouCount(rows: QueryRow[], statusId: string, waitingId: string) {
  const delivered = new Set(rows.filter((row) => !row.parentRowId && row.cells[statusId] === "ready_for_review").map((row) => row.id));
  return waitingOnYouRows(rows, statusId, waitingId).filter((row) => !row.parentRowId || !delivered.has(row.parentRowId)).length;
}

// Planned rows count while the job is open; closed legacy jobs ignore taskless extras.
export function subtaskProgress(database: Database, query: Database): Record<string, { done: number; total: number }> {
  const status = database.properties.find((p) => p.type === "agentStatus"), progress: Record<string, { done: number; total: number }> = {};
  if (!status) return progress;
  const parents = new Map(query.rows.map((row) => [row.id, row.cells[status.id]]));
  for (const row of query.rows) {
    const state = row.cells[status.id];
    if (!row.parentRowId || state === "cancelled") continue;
    if ((!state || state === "pending") && (!parents.has(row.parentRowId) || [undefined, null, "done", "failed", "cancelled"].includes(parents.get(row.parentRowId) as string | null | undefined))) continue;
    const entry = progress[row.parentRowId] ??= { done: 0, total: 0 };
    entry.total += 1;
    if (state === "done") entry.done += 1;
  }
  return progress;
}
