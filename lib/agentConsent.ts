import type { SupabaseClient } from "@supabase/supabase-js";

export type ConsentState =
  | { kind: "redirect"; url: string }
  | { kind: "ask"; authorizationId: string; clientId: string; clientName: string; redirectHost: string; redirectIsApp: boolean; email: string };
export interface LinkableAgent { id: string; name: string; workspace_id: string; role: string }
export interface ConnectedApp { clientId: string; name: string; agentName: string | null; linked: boolean; revoked: boolean }

const BLOCKED = new Set(["javascript:", "data:", "vbscript:"]);

/** The server validates the redirect against the client, but the client registered itself. */
export function safeRedirect(url: string): string | null {
  try { return BLOCKED.has(new URL(url).protocol) ? null : url; } catch { return null; }
}
export function hostOf(uri: string): string {
  try { const url = new URL(uri); return url.protocol === "https:" ? url.origin : uri; } catch { return uri; }
}

/** This read also binds the authorization to the person; approving without it returns 404. */
export async function loadConsent(client: SupabaseClient, authorizationId: string): Promise<ConsentState> {
  const { data, error } = await client.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error) throw error;
  if ("redirect_url" in data) return { kind: "redirect", url: data.redirect_url };
  return { kind: "ask", authorizationId, clientId: data.client.id, clientName: data.client.name || "An app",
    redirectHost: hostOf(data.redirect_uri), redirectIsApp: !["http:", "https:"].includes(new URL(data.redirect_uri).protocol), email: data.user.email };
}
export async function linkableAgents(client: SupabaseClient): Promise<LinkableAgent[]> {
  const { data, error } = await client.rpc("linkable_agents");
  if (error) throw error;
  return (data ?? []) as LinkableAgent[];
}
export async function approveConsent(client: SupabaseClient, authorizationId: string, clientId: string, agentId: string | null): Promise<string> {
  const link = await client.rpc("set_oauth_link", { p_client_id: clientId, p_agent_id: agentId });
  if (link.error) throw link.error;
  const { data, error } = await client.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
  if (error) throw error;
  return data.redirect_url;
}
export async function denyConsent(client: SupabaseClient, authorizationId: string): Promise<string> {
  const { data, error } = await client.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
  if (error) throw error;
  return data.redirect_url;
}
export async function disconnectApp(client: SupabaseClient, clientId: string, linked: boolean): Promise<void> {
  if (linked) {
    const { error } = await client.rpc("revoke_oauth_link", { p_client_id: clientId });
    if (error) throw error;
  }
  const { error } = await client.auth.oauth.revokeGrant({ clientId });
  if (error) throw error;
}
export async function connectedApps(client: SupabaseClient): Promise<ConnectedApp[]> {
  const [grants, links] = await Promise.all([
    client.auth.oauth.listGrants(),
    client.from("agent_oauth_links").select("client_id,revoked_at,agents(name)"),
  ]);
  if (grants.error) throw grants.error;
  if (links.error) throw links.error;
  return grants.data.map(({ client: app }) => {
    const link = links.data.find((l) => l.client_id === app.id);
    const agent = link?.agents as unknown as { name: string } | null;
    return { clientId: app.id, name: app.name || "An app", agentName: link ? agent?.name ?? "agent" : null,
      linked: Boolean(link && !link.revoked_at), revoked: Boolean(link?.revoked_at) };
  });
}
