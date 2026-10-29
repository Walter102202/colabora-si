import { describe, expect, it } from "vitest";
import { agentSubtitle } from "@/components/agents/settings/agentLabel";
import type { AgentRow } from "@/lib/agentsStore";
const base = { id: "a", workspace_id: "w", auth_user_id: "u", name: "Colabora", delivery: "pull", sponsor_user_id: "s", status: "enabled",
  monthly_budget_usd: 20, capabilities: {}, connection: {}, rate_limit_per_min: 120, created_at: "2026-10-30T00:00:00Z",
  updated_at: new Date().toISOString(), revoked_at: null } as const;
describe("agentSubtitle", () => {
  it("marks the platform agent", () => {
    const row: AgentRow = { ...base, kind: "managed", role: "lead", is_platform: true };
    expect(agentSubtitle(row).startsWith("Platform · Lead · Managed · updated ")).toBe(true);
  });
  it("leaves other agents as they were", () => {
    const row: AgentRow = { ...base, kind: "acp_local", role: "worker", is_platform: false };
    expect(agentSubtitle(row).startsWith("Worker · Local harness · updated ")).toBe(true);
  });
});
