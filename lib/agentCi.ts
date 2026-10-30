import type { SupabaseClient } from "@supabase/supabase-js";

export type CiState = "no_commit" | "not_connected" | "pending" | "passed" | "failed";
export interface CiCheckRow { criterion_id: string; check: string; state: CiState; repo?: string; sha?: string; conclusion?: string; url?: string; branch?: string; completed_at?: string }
export interface CiConnection { id: string; repo: string; last_delivery_at: string | null }
export interface NewCiConnection { id: string; repo: string; webhook_url: string; secret: string }

export const CI_LABEL: Record<CiState, string> = {
  no_commit: "No commit delivered yet",
  not_connected: "Repository not connected",
  pending: "Waiting for CI",
  passed: "CI passed",
  failed: "CI failed",
};

/** The person runs this with their own GitHub access. Creating a local connection never installs a webhook. */
export function ghWebhookCommand(repo: string, url: string, secret: string): string {
  return `gh api repos/${repo}/hooks -f name=web -F active=true -f "events[]=check_run" -f "config[url]=${url}" -f "config[content_type]=json" -f "config[secret]=${secret}"`;
}
export async function connectRepository(client: SupabaseClient, workspaceId: string, repo: string): Promise<NewCiConnection> {
  const { data, error } = await client.functions.invoke("agent-admin", { body: { action: "ci_connect", workspace_id: workspaceId, repo } });
  if (error) throw error;
  await refreshLoadedChecks(workspaceId);
  return data as NewCiConnection;
}
export async function listConnections(client: SupabaseClient, workspaceId: string): Promise<CiConnection[]> {
  const { data, error } = await client.from("ci_connections").select("id,repo,last_delivery_at")
    .eq("workspace_id", workspaceId).is("revoked_at", null).order("repo");
  if (error) throw error;
  return (data ?? []) as CiConnection[];
}
export async function revokeConnection(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc("revoke_ci_connection", { p_id: id });
  if (error) throw error;
  await refreshLoadedChecks();
}

// Loaded only for settings mutations: importing CI_LABEL in the pure chat card must not start a store or client.
async function refreshLoadedChecks(workspaceId?: string): Promise<void> {
  const { useAgentTasks } = await import("@/lib/agentTasks");
  if (workspaceId) await useAgentTasks.getState().refreshCiChecks(workspaceId);
  else await useAgentTasks.getState().refreshCiChecks();
}

/** Mirrors private.is_workspace_owner; the RPC remains the authorization boundary. */
export async function canManageConnections(client: SupabaseClient, workspaceId: string, userId: string): Promise<boolean> {
  const [workspace, member] = await Promise.all([
    client.from("workspaces").select("id").eq("id", workspaceId).eq("owner_id", userId).maybeSingle(),
    client.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).eq("role", "owner").maybeSingle(),
  ]);
  if (workspace.error) throw workspace.error;
  if (member.error) throw member.error;
  return Boolean(workspace.data || member.data);
}
