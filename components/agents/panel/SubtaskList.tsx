"use client";

import { useMemo } from "react";
import { useAgentsStore } from "@/lib/agentsStore";
import { useAgentTasks } from "@/lib/agentTasks";
import { StatusBadge } from "@/components/agents/AgentPropertyCell";

// Subtasks a Lead opened under this task, with their state and worker.
export function SubtaskList({ parentId, onOpenTask }: { parentId: string; onOpenTask: (pageId: string, taskId: string) => void }) {
  const tasks = useAgentTasks((s) => s.tasks);
  const runs = useAgentTasks((s) => s.runs);
  const agents = useAgentsStore((s) => s.agents);
  const subtasks = useMemo(
    () => Object.values(tasks).filter((t) => t.parent_task_id === parentId).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [tasks, parentId],
  );
  if (subtasks.length === 0) return null;
  const open = subtasks.filter((t) => !["done", "failed", "cancelled"].includes(t.state)).length;
  return (
    <section className="space-y-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
        Subtasks · {subtasks.length - open} of {subtasks.length} closed
      </h4>
      <ul className="divide-y divide-border rounded-md border border-border">
        {subtasks.map((t) => {
          const agent = agents.find((a) => a.id === t.delegate_agent_id);
          const run = t.active_run_id ? (runs[t.active_run_id] ?? null) : null;
          return (
            <li key={t.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-bg-secondary"
                onClick={() => onOpenTask(t.row_page_id, t.id)}
              >
                <span className="min-w-0 flex-1 truncate">{t.title || "Untitled subtask"}</span>
                <span className="shrink-0 text-xs text-text-tertiary">{agent?.name ?? "unassigned"}</span>
                <StatusBadge task={t} run={run} agentName={agent?.name ?? null} compact />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
