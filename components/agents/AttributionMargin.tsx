"use client";

import type { BlockAttr } from "@/lib/types";
import { useAgentsStore } from "@/lib/agentsStore";
import { useAgentTasks } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";

// Agent layer plug. Mounted by the block wrapper of the editor, to the left of
// the drag handle. A colored dot with the agent and run that last edited the
// block; nothing for human edits.
export interface AttributionMarginProps {
  blockId: string;
  attr?: BlockAttr;
}

export function AttributionMargin({ attr }: AttributionMarginProps) {
  // The server stamps the agent's auth user id; older rows may carry the agent id.
  const agent = useAgentsStore((s) => (attr?.by === "agent" ? s.agents.find((a) => a.auth_user_id === attr.id || a.id === attr.id) : undefined));
  const run = useAgentTasks((s) => (attr?.runId ? s.runs[attr.runId] : undefined));
  if (!attr || attr.by !== "agent") return null;
  const name = agent?.name ?? "Agent";
  const runLabel = attr.runId ? ` · run ${attr.runId.slice(0, 8)}` : "";
  const when = attr.at ? ` · ${formatRelative(attr.at)}` : "";
  const status = run ? ` (${run.status})` : "";
  return (
    <span
      contentEditable={false}
      aria-label={`Edited by ${name}`}
      title={`${name}${runLabel}${status}${when}`}
      className="attribution-margin absolute -left-5 top-2 h-2 w-2 rounded-full bg-accent"
    />
  );
}
