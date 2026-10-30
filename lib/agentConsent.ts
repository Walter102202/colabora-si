import type { SupabaseClient } from "@supabase/supabase-js";

export type ConsentState =
  | { kind: "redirect"; url: string }
  | { kind: "ask"; authorizationId: string; clientId: string; clientName: string; redirectUri: string; redirectHost: string; redirectIsApp: boolean; email: string };
export interface LinkableAgent { id: string; name: string; workspace_id: string; role: string }
export interface ConnectedApp { clientId: string; name: string; agentId: string | null; agentName: string | null; redirectHost: string; linked: boolean; revoked: boolean }

const BLOCKED = new Set(["javascript:", "data:", "vbscript:"]);
// As-you tokens are full human sessions. This is the single policy list for trusted hosts.
export const TRUSTED_HUMAN_HOSTS = new Set(["claude.ai", "chatgpt.com"]);
export function trustedHumanRedirect(uri: string): boolean {
  try { const url = new URL(uri); return url.protocol === "https:" && TRUSTED_HUMAN_HOSTS.has(url.host); } catch { return false; }
}
export function safeRedirect(url: string): string | null {
  try { return BLOCKED.has(new URL(url).protocol) ? null : url; } catch { return null; }
}
export function hostOf(uri: string): string {
  try { const url = new URL(uri); return url.protocol === "https:" ? url.origin : uri; } catch { return uri; }
}
export class UntrustedHumanApp extends Error {
  constructor() { super("This app cannot connect as you. Go back to the app and connect again, choosing As an agent."); }
}

async function adminAction(client: SupabaseClient, body: Record<string, unknown>) {
  const { data, error } = await client.functions.invoke("agent-admin", { body });
  if (error) {
    const response = (error as { context?: Response }).context;
    if (response instanceof Response) {
      const details = await response.clone().json().catch(() => null) as { error_description?: string } | null;
      if (details?.error_description) throw new Error(details.error_description);
    }
    throw error;
  }
  return data;
}
async function recordHumanApp(client: SupabaseClient, clientId: string, name: string, uri: string) {
  const { error } = await client.rpc("set_oauth_app", { p_client_id: clientId, p_agent_id: null, p_client_name: name, p_redirect_uri: uri });
  if (error) throw error;
}

/** Identity is selected before this call: only the chosen principal reads the authorization in Auth. */
export async function loadConsent(client: SupabaseClient, authorizationId: string, agentId: string | null = null): Promise<ConsentState> {
  let data;
  if (agentId) {
    data = await adminAction(client, { action: "oauth_read", authorization_id: authorizationId, agent_id: agentId });
  } else {
    const context = await client.rpc("oauth_human_context", { p_authorization_id: authorizationId });
    if (context.error) throw context.error;
    const app = context.data as { client_id: string; client_name: string; redirect_uri: string };
    if (!trustedHumanRedirect(app.redirect_uri)) {
      // Remove remembered consent first, so the subsequent read cannot silently issue a code.
      const revoked = await client.auth.oauth.revokeGrant({ clientId: app.client_id });
      if (revoked.error && revoked.error.status !== 404) throw revoked.error;
      const read = await client.auth.oauth.getAuthorizationDetails(authorizationId);
      if (read.error) throw read.error;
      const denied = await client.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (denied.error) throw denied.error;
      throw new UntrustedHumanApp();
    }
    const read = await client.auth.oauth.getAuthorizationDetails(authorizationId);
    if (read.error) throw read.error;
    data = read.data;
    if ("redirect_url" in data) {
      if (!trustedHumanRedirect(data.redirect_url)) throw new UntrustedHumanApp();
      await recordHumanApp(client, app.client_id, app.client_name || "An app", app.redirect_uri);
    }
  }
  if ("redirect_url" in data) return { kind: "redirect", url: data.redirect_url };
  return { kind: "ask", authorizationId, clientId: data.client.id, clientName: data.client.name || "An app", redirectUri: data.redirect_uri,
    redirectHost: hostOf(data.redirect_uri), redirectIsApp: !["http:", "https:"].includes(new URL(data.redirect_uri).protocol), email: data.user.email };
}
export async function linkableAgents(client: SupabaseClient): Promise<LinkableAgent[]> {
  const { data, error } = await client.rpc("linkable_agents");
  if (error) throw error;
  return (data ?? []) as LinkableAgent[];
}
export async function approveConsent(client: SupabaseClient, authorizationId: string, clientId: string, agentId: string | null,
  detail?: { clientName: string; redirectUri: string }): Promise<string> {
  if (agentId) return (await adminAction(client, { action: "oauth_approve", authorization_id: authorizationId, agent_id: agentId })).redirect_url;
  if (!detail || !trustedHumanRedirect(detail.redirectUri)) throw new UntrustedHumanApp();
  const { data, error } = await client.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
  if (error) throw error;
  await recordHumanApp(client, clientId, detail.clientName, detail.redirectUri);
  return data.redirect_url;
}
export async function denyConsent(client: SupabaseClient, authorizationId: string, agentId: string | null = null): Promise<string> {
  if (agentId) return (await adminAction(client, { action: "oauth_deny", authorization_id: authorizationId, agent_id: agentId })).redirect_url;
  const { data, error } = await client.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
  if (error) throw error;
  return data.redirect_url;
}
export async function disconnectApp(client: SupabaseClient, clientId: string, active: boolean, agentId: string | null = null): Promise<void> {
  if (agentId) { await adminAction(client, { action: "oauth_disconnect", client_id: clientId, agent_id: agentId }); return; }
  if (active) {
    const { error } = await client.rpc("revoke_oauth_link", { p_client_id: clientId });
    if (error) throw error;
  }
  const { error } = await client.auth.oauth.revokeGrant({ clientId });
  if (error) throw error;
}
export async function connectedApps(client: SupabaseClient): Promise<ConnectedApp[]> {
  const { data, error } = await client.from("agent_oauth_links").select("client_id,client_name,redirect_uri,agent_id,as_human,revoked_at,agents(name)");
  if (error) throw error;
  return (data ?? []).map((link) => {
    const agent = link.agents as unknown as { name: string } | null;
    const revoked = Boolean(link.revoked_at || (!link.as_human && !link.agent_id));
    return { clientId: link.client_id, name: link.client_name || "An app", agentId: link.agent_id,
      agentName: link.as_human ? null : agent?.name ?? "agent", redirectHost: hostOf(link.redirect_uri ?? ""), linked: !revoked, revoked };
  });
}
