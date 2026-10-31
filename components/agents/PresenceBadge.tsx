"use client";

import { SourcesBadge } from "@/components/agents/SourcesBadge";
import { useAgentsStore } from "@/lib/agentsStore";
import { activeRunFor, taskForPage, useAgentTasks } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";

// Agent layer plug. Mounted in the topbar, between the presence avatars and
// the reminder bell. Shows the agent with an active run on this page.
export interface PresenceBadgeProps {
  pageId: string;
}

export function PresenceBadge({ pageId }: PresenceBadgeProps) {
  return <><SourcesBadge pageId={pageId} /><RunBadge pageId={pageId} /></>;
}

function RunBadge({ pageId }: PresenceBadgeProps) {
  const task = useAgentTasks((s) => taskForPage(s, pageId));
  const run = useAgentTasks((s) => (task ? activeRunFor(s, task) : null));
  const agent = useAgentsStore((s) => (run ? s.agents.find((a) => a.id === run.agent_id) : undefined));
  if (!task || !run || (run.status !== "running" && run.status !== "waiting")) return null;
  const name = agent?.name ?? "An agent";
  const waiting = run.status === "waiting";
  return (
    <span
      className="hidden items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary md:inline-flex"
      title={`Run started ${formatRelative(Date.parse(run.started_at))}${run.stale_at ? " · no signals lately" : ""}`}
    >
      <span className={"h-2 w-2 rounded-full " + (waiting ? "bg-yellow-500" : run.stale_at ? "bg-text-tertiary" : "animate-pulse bg-green-500")} />
      {waiting ? `${name} is waiting for you` : `${name} is working`}
    </span>
  );
}
