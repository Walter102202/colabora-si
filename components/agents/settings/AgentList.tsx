"use client";

import type { AgentRow } from "@/lib/agentsStore";
import { agentSubtitle } from "./agentLabel";

const STATUS_LABEL: Record<AgentRow["status"], string> = { enabled: "Active", paused: "Paused", disabled: "Disabled" };
export function AgentList({ agents, onOpen }: { agents: AgentRow[]; onOpen: (id: string) => void }) {
  if (agents.length === 0) {
    return <p className="text-sm text-text-secondary">Register your first agent.</p>;
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {agents.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-bg-secondary"
            onClick={() => onOpen(a.id)}
          >
            <span
              aria-hidden
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-xs font-semibold text-accent"
            >
              {a.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{a.name}</span>
              <span className="block truncate text-xs text-text-secondary">
                {agentSubtitle(a)}
              </span>
            </span>
            <span
              className={
                "rounded px-1.5 py-0.5 text-xs " +
                (a.status === "enabled" ? "bg-green-500/15 text-green-700 dark:text-green-400" : a.status === "paused" ? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400" : "bg-bg-secondary text-text-tertiary")
              }
            >
              {STATUS_LABEL[a.status]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
