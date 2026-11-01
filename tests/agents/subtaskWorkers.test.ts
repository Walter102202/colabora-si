import { expect, it } from "vitest";
import { subtaskWorkers, type TaskRow } from "@/lib/agentTasks";

const task = (id: string, patch: Partial<TaskRow>) => ({ id, parent_task_id: "job", delegate_agent_id: "codex", request_kind: null, ...patch }) as TaskRow;

it("names each worker of a task's subtasks once", () => {
  const tasks = { a: task("a", {}), b: task("b", {}), c: task("c", { delegate_agent_id: "cursor" }) };
  expect(subtaskWorkers(tasks, "job")).toEqual(["codex", "cursor"]);
});
it("leaves out other tasks, requests and subtasks with no worker", () => {
  const tasks = { a: task("a", { parent_task_id: "other" }), b: task("b", { request_kind: "lesson" }), c: task("c", { delegate_agent_id: null }) };
  expect(subtaskWorkers(tasks, "job")).toEqual([]);
});
