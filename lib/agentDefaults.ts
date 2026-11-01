import type { AgentKind, AgentRole, NewAgentInput } from "@/lib/agentsStore";

export const DEFAULT_CAPABILITIES: Record<string, boolean> = { start: false, continue: false, cancel: false, events: false, approval: true, cost: false, files: false };
export const RESUME_HARNESSES = new Set(["claude-code", "codex", "cursor", "gemini-cli", "agent"]);
export const HARNESS_KIND: Record<string, AgentKind> = { "claude-code": "acp_local", codex: "acp_local", "claude-ai": "mcp_client", chatgpt: "mcp_client", cursor: "acp_local", "gemini-cli": "acp_local", agent: "webhook" };
export function agentInputFor(name: string, harness: string, role: AgentRole, grants: NewAgentInput["grants"] = []): NewAgentInput {
  return { name: name.trim(), kind: HARNESS_KIND[harness] ?? "acp_local", role,
    capabilities: { ...DEFAULT_CAPABILITIES, resume: RESUME_HARNESSES.has(harness) },
    monthly_budget_usd: null, rate_limit_per_min: 120, grants, harness };
}
