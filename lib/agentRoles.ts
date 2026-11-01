import { AUTONOMY_LABEL, type AutonomyLevel } from "@/lib/agentAutonomy";
import type { ConnectedRow } from "@/lib/agentConnect";

type RoleRow = Pick<ConnectedRow, "name" | "role" | "autonomy">;
const rank: Record<AutonomyLevel, number> = { ask: 0, balanced: 1, autonomous: 2 };

// This describes the configured levels. Permissions always come from the server.
export function agentEffect(row: RoleRow, rows: RoleRow[], workspaceLevel: AutonomyLevel): string | null {
  if (workspaceLevel === "ask") return "Stopped: the workspace is at Ask first.";
  if (row.role !== "worker") return null;
  const own = (agent: RoleRow) => agent.autonomy ?? workspaceLevel;
  const lower = rows.filter((agent) => agent.role === "lead" && rank[own(agent)] < rank[own(row)])
    .sort((a, b) => rank[own(a)] - rank[own(b)])[0];
  return lower ? `Held to ${AUTONOMY_LABEL[own(lower)]} under ${lower.name}.` : null;
}
