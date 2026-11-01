import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { getSupabase } from "@/lib/supabase";
import { useAuthStore } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";
import { connectWorkspaces } from "@/lib/agentConsent";
import { CONNECT_AGENT_NAMES } from "@/lib/agentConnectCatalog";

export interface ConnectionRow {
  agent_id: string;
  page_id: string;
  approved_at: string | null;
  verified_at: string | null;
  created_at: string;
}
export interface ConnectAttempt { agent: string; startedAt: number; agentId?: string; }

export type ConnectedStatus = "connected" | "waiting" | "manual";
export interface ConnectedRow { agentId: string; name: string; logo: string | null; status: ConnectedStatus; since: string | null; pageId: string | null; }
export function connectedRows(agents: { id: string; name: string; is_platform: boolean; revoked_at: string | null }[], connections: ConnectionRow[]): ConnectedRow[] {
  return agents.filter((agent) => !agent.is_platform && !agent.revoked_at).map((agent): ConnectedRow => {
    const connection = connections.find((row) => row.agent_id === agent.id);
    const catalogId = Object.entries(CONNECT_AGENT_NAMES).find(([, name]) => name.toLowerCase() === agent.name.toLowerCase())?.[0];
    return { agentId: agent.id, name: agent.name, logo: catalogId ? `/brand/agents/${catalogId}.svg` : null,
      status: connection ? connection.verified_at ? "connected" : "waiting" : "manual",
      since: connection?.verified_at ?? connection?.created_at ?? null, pageId: connection?.page_id ?? null };
  }).sort((a, b) => Number(a.status === "manual") - Number(b.status === "manual")
    || (b.since ? Date.parse(b.since) : 0) - (a.since ? Date.parse(a.since) : 0));
}

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

type ConnectGate = "loading" | "show" | "hide";
// The Home card shares the gate's result rather than fetching the same data twice.
export const useConnectEligibility = create<{ key: string; gate: ConnectGate; canConnect: boolean; hasVerified: boolean }>(() => ({
  key: "", gate: "hide", canConnect: false, hasVerified: false,
}));
export function useConnectGate(): ConnectGate {
  const client = getSupabase(), userId = useAuthStore((state) => state.user?.id), workspaceId = useStore((state) => state.syncWorkspaceId);
  const key = `${userId ?? ""}:${workspaceId ?? ""}`;
  const [snapshot, setSnapshot] = useState<{ key: string; gate: ConnectGate }>({ key: "", gate: "loading" });
  useEffect(() => {
    if (!client || !userId || !workspaceId) return;
    let settled = false;
    useConnectEligibility.setState({ key, gate: "loading", canConnect: false, hasVerified: false });
    const hide = () => { if (!settled) { settled = true; setSnapshot({ key, gate: "hide" }); useConnectEligibility.setState({ key, gate: "hide", canConnect: false, hasVerified: false }); } };
    const timer = setTimeout(hide, 3000);
    void Promise.all([connectWorkspaces(client), useAgentsStore.getState().load(workspaceId), loadConnections(client, workspaceId)]).then(([spaces, , connections]) => {
      if (settled) return;
      const state = useAgentsStore.getState();
      if (state.status !== "ready" || state.workspaceId !== workspaceId || state.userId !== userId) { hide(); return; }
      const canConnect = spaces.some((space) => space.id === workspaceId);
      const hasVerified = connections.some((row) => row.verified_at && state.agents.some((agent) => agent.id === row.agent_id && !agent.is_platform && !agent.revoked_at));
      const show = shouldShowConnect({ canConnect, skipped: hasSkippedConnect(workspaceId), agents: state.agents, connections });
      settled = true; clearTimeout(timer); setSnapshot({ key, gate: show ? "show" : "hide" }); useConnectEligibility.setState({ key, gate: show ? "show" : "hide", canConnect, hasVerified });
    }).catch(hide);
    return () => { settled = true; clearTimeout(timer); };
  }, [client, userId, workspaceId, key]);
  if (!client || !userId || !workspaceId) return "hide";
  return snapshot.key === key ? snapshot.gate : "loading";
}
