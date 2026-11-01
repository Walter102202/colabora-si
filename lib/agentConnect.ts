import type { SupabaseClient } from "@supabase/supabase-js";

export interface ConnectionRow {
  agent_id: string;
  page_id: string;
  approved_at: string | null;
  verified_at: string | null;
  created_at: string;
}
export interface ConnectAttempt { agent: string; startedAt: number; agentId?: string; }

export function shouldShowConnect(input: {
  canConnect: boolean; skipped: boolean;
  agents: { id: string; is_platform: boolean; revoked_at: string | null }[];
  connections: ConnectionRow[];
}): boolean {
  const external = input.agents.filter((agent) => !agent.is_platform && !agent.revoked_at);
  return input.canConnect && !input.skipped
    && !input.connections.some((row) => row.verified_at && external.some((agent) => agent.id === row.agent_id))
    && external.every((agent) => input.connections.some((row) => row.agent_id === agent.id));
}

export function pickConnection(rows: ConnectionRow[], attempt: { startedAt: number; agentId?: string }): ConnectionRow | null {
  if (attempt.agentId) return rows.find((row) => row.agent_id === attempt.agentId) ?? null;
  return rows.filter((row) => row.approved_at && Date.parse(row.approved_at) >= attempt.startedAt - 60_000)
    .sort((a, b) => Date.parse(b.approved_at!) - Date.parse(a.approved_at!))[0] ?? null;
}

export function connectStep(attempt: { copied: boolean } | null, row: ConnectionRow | null): "setup" | "waiting" | "approved" | "connected" {
  if (row?.verified_at) return "connected";
  if (row?.approved_at) return "approved";
  return attempt?.copied ? "waiting" : "setup";
}

export async function loadConnections(client: SupabaseClient, workspaceId: string): Promise<ConnectionRow[]> {
  const { data, error } = await client.from("agent_connections")
    .select("agent_id,page_id,approved_at,verified_at,created_at").eq("workspace_id", workspaceId);
  if (error) throw error;
  return (data ?? []) as ConnectionRow[];
}

export function loadConnectAttempt(): ConnectAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem("colabora-connect-attempt") ?? "null");
    return value && typeof value.agent === "string" && Number.isFinite(value.startedAt)
      && (value.agentId === undefined || typeof value.agentId === "string") ? value : null;
  } catch { return null; }
}
export function saveConnectAttempt(attempt: ConnectAttempt | null): void {
  try {
    if (attempt) sessionStorage.setItem("colabora-connect-attempt", JSON.stringify(attempt));
    else sessionStorage.removeItem("colabora-connect-attempt");
  } catch { /* Storage is optional; the active screen still works. */ }
}
function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === "true"; } catch { return false; }
}
function writeFlag(key: string, value: boolean): void {
  try { localStorage.setItem(key, String(value)); } catch { /* Storage can be disabled. */ }
}
export function hasSkippedConnect(workspace: string): boolean { return readFlag(`colabora-connect-skipped:${workspace}`); }
export function setConnectSkipped(workspace: string, value = true): void { writeFlag(`colabora-connect-skipped:${workspace}`, value); }
export function isConnectCardHidden(workspace: string): boolean { return readFlag(`colabora-connect-card-hidden:${workspace}`); }
export function setConnectCardHidden(workspace: string, value = true): void { writeFlag(`colabora-connect-card-hidden:${workspace}`, value); }
