import type { Database, DbProperty } from "@/lib/types";
import type { TaskRow } from "@/lib/agentTasks";
import { TASK_STATE_LABEL } from "@/lib/agentState";
type TaskValue = Pick<TaskRow, "row_page_id" | "state" | "delegate_agent_id" | "updated_at">;

// Query-only cells; the source database keeps its rows and agent property types.
export function databaseTaskValues(database: Database, tasks: Record<string, TaskValue>): Database {
  const properties = database.properties.filter((p) => p.type === "agentStatus" || p.type === "agentDelegate");
  if (!properties.length) return database;
  const byPage = new Map<string, TaskValue>();
  const terminal = (task: TaskValue) => ["done", "failed", "cancelled"].includes(task.state);
  for (const task of Object.values(tasks)) {
    const previous = byPage.get(task.row_page_id);
    if (!previous || (terminal(previous) && !terminal(task)) || (terminal(previous) === terminal(task) && task.updated_at > previous.updated_at)) byPage.set(task.row_page_id, task);
  }
  return {
    ...database,
    properties: database.properties.map((p): DbProperty => p.type === "agentStatus"
      ? { ...p, type: "select", options: Object.entries(TASK_STATE_LABEL).map(([id, name]) => ({ id, name, color: "gray" })) }
      : p.type === "agentDelegate" ? { ...p, type: "text" } : p),
    rows: database.rows.map((row) => {
      const task = byPage.get(row.pageId), cells = { ...row.cells };
      for (const property of properties) cells[property.id] = property.type === "agentStatus" ? task?.state ?? null : task?.delegate_agent_id ?? null;
      return { ...row, cells };
    }),
  };
}
