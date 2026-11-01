"use client";

import type { BlockAttr } from "@/lib/types";
import { useAgentsStore } from "@/lib/agentsStore";
import { useAgentTasks } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";

// Agent layer plug. Mounted by the block wrapper of the editor. A thin line
// beside the text says an agent last edited the block, and hovering the block
// names it. Nothing for human edits.
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
    <>
      <span
        contentEditable={false}
        role="img"
        aria-label={`Edited by ${name}`}
        title={`${name}${runLabel}${attr.via ? " · via chat" : ""}${status}${when}`}
        className="attribution-margin"
      />
      <span contentEditable={false} aria-hidden="true" className="attribution-name">Edited by {name}</span>
    </>
  );
}
