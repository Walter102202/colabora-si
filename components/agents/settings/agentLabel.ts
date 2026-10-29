import type { AgentRow } from "@/lib/agentsStore";
import { formatRelative } from "@/lib/utils";

const KIND_LABEL: Record<AgentRow["kind"], string> = {
  mcp_client: "Chat app",
  webhook: "Webhook",
  a2a: "A2A",
  managed: "Managed",
  acp_local: "Local harness",
};

/** One line under an agent's name in Settings: platform mark, role, kind and the last update. */
export function agentSubtitle(a: AgentRow): string {
  return `${a.is_platform ? "Platform · " : ""}${a.role === "lead" ? "Lead" : "Worker"} · ${KIND_LABEL[a.kind]} · updated ${formatRelative(Date.parse(a.updated_at))}`;
}
