import { create } from "zustand";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";

// Non-persisted store behind Settings → Agents. Reads through RLS with the
// person's session; writes go through the identity RPCs and the agent-admin
// function. Never touches the workspace store.

export type AgentKind = "mcp_client" | "webhook" | "a2a" | "managed" | "acp_local";
export type AgentRole = "worker" | "lead";
export type AgentStatus = "enabled" | "paused" | "disabled";

export interface AgentRow {
  id: string;
  workspace_id: string;
  auth_user_id: string;
  name: string;
  kind: AgentKind;
  delivery: "pull" | "push";
  role: AgentRole;
  sponsor_user_id: string;
  status: AgentStatus;
  monthly_budget_usd: number | null;
  capabilities: Record<string, boolean>;
  connection: Record<string, unknown>;
  rate_limit_per_min: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface GrantRow {
  id: string;
  agent_id: string;
  page_id: string;
  scopes: string[];
  inherit: boolean;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface TokenRow {
  id: string;
  agent_id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface NewAgentInput {
  name: string;
  kind: AgentKind;
  role: AgentRole;
  capabilities: Record<string, boolean>;
  monthly_budget_usd: number | null;
  rate_limit_per_min: number;
  grants: { pageId: string; scopes: string[]; inherit: boolean }[];
  harness: string;
}

export interface AgentsState {
  status: "idle" | "loading" | "ready" | "signed_out" | "unavailable" | "error";
  error: string | null;
  workspaceId: string | null;
  userId: string | null;
  agents: AgentRow[];
  grants: GrantRow[];
  tokens: TokenRow[];
  load: (workspaceId?: string | null) => Promise<void>;
  createAgent: (input: NewAgentInput) => Promise<{ agentId: string; token: string }>;
  issueToken: (agentId: string, name: string) => Promise<string>;
  revokeToken: (tokenId: string) => Promise<void>;
  grantPage: (agentId: string, pageId: string, scopes: string[], inherit: boolean) => Promise<void>;
  revokeGrant: (grantId: string) => Promise<void>;
  setPaused: (agentId: string, paused: boolean) => Promise<void>;
  revokeAgent: (agentId: string, reason?: string) => Promise<void>;
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const client = getAgentClient();
  if (!client) throw new Error("Cloud is not configured.");
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(agentErrorMessage(error));
  return data as T;
}

export const useAgentsStore = create<AgentsState>()((set, get) => ({
  status: "idle",
  error: null,
  workspaceId: null,
  userId: null,
  agents: [],
  grants: [],
  tokens: [],

  async load(workspaceId) {
    const client = getAgentClient();
    if (!client) {
      set({ status: "unavailable" });
      return;
    }
    set({ status: "loading", error: null });
    try {
      const { data: session } = await client.auth.getSession();
      const userId = session.session?.user.id ?? null;
      if (!userId) {
        set({ status: "signed_out", userId: null });
        return;
      }
      let ws = workspaceId ?? get().workspaceId;
      if (!ws) {
        const { data: members } = await client.from("workspace_members").select("workspace_id").eq("user_id", userId).limit(1);
        ws = members?.[0]?.workspace_id ?? null;
      }
      if (!ws) {
        set({ status: "ready", userId, workspaceId: null, agents: [], grants: [], tokens: [] });
        return;
      }
      const [agents, grants, tokens] = await Promise.all([
        client.from("agents").select("*").eq("workspace_id", ws).order("created_at"),
        client.from("agent_grants").select("*").eq("workspace_id", ws).is("revoked_at", null),
        client.from("agent_tokens_safe").select("*").eq("workspace_id", ws).is("revoked_at", null),
      ]);
      const firstError = agents.error ?? grants.error ?? tokens.error;
      if (firstError) throw new Error(agentErrorMessage(firstError));
      set({
        status: "ready",
        userId,
        workspaceId: ws,
        agents: (agents.data ?? []) as AgentRow[],
        grants: (grants.data ?? []) as GrantRow[],
        tokens: (tokens.data ?? []) as TokenRow[],
      });
    } catch (e) {
      set({ status: "error", error: agentErrorMessage(e) });
    }
  },

  async createAgent(input) {
    const client = getAgentClient();
    const ws = get().workspaceId;
    if (!client || !ws) throw new Error("Sign in to manage agents.");
    const { data, error } = await client.functions.invoke("agent-admin", {
      body: {
        action: "create_agent",
        workspace_id: ws,
        name: input.name,
        kind: input.kind,
        role: input.role,
        capabilities: input.capabilities,
        connection: { harness: input.harness },
        monthly_budget_usd: input.monthly_budget_usd,
      },
    });
    if (error) throw new Error(agentErrorMessage(error));
    const agentId = (data as { agent_id?: string })?.agent_id;
    if (!agentId) throw new Error("The agent was not created.");
    if (input.rate_limit_per_min !== 120) {
      await rpc("update_agent", { p_agent_id: agentId, p_patch: { rate_limit_per_min: input.rate_limit_per_min } });
    }
    for (const g of input.grants) {
      await rpc("grant_agent_page", { p_agent_id: agentId, p_page_id: g.pageId, p_scopes: g.scopes, p_inherit: g.inherit });
    }
    const token = await get().issueToken(agentId, "default");
    await get().load();
    return { agentId, token };
  },

  async issueToken(agentId, name) {
    const res = await rpc<{ token: string }>("issue_agent_token", { p_agent_id: agentId, p_name: name });
    await get().load();
    return res.token;
  },

  async revokeToken(tokenId) {
    await rpc("revoke_agent_token", { p_token_id: tokenId });
    await get().load();
  },

  async grantPage(agentId, pageId, scopes, inherit) {
    await rpc("grant_agent_page", { p_agent_id: agentId, p_page_id: pageId, p_scopes: scopes, p_inherit: inherit });
    await get().load();
  },

  async revokeGrant(grantId) {
    await rpc("revoke_agent_grant", { p_grant_id: grantId });
    await get().load();
  },

  async setPaused(agentId, paused) {
    await rpc("update_agent", { p_agent_id: agentId, p_patch: { status: paused ? "paused" : "enabled" } });
    await get().load();
  },

  async revokeAgent(agentId, reason) {
    const client = getAgentClient();
    if (!client) throw new Error("Cloud is not configured.");
    const { error } = await client.functions.invoke("agent-admin", { body: { action: "revoke_agent", agent_id: agentId, reason: reason ?? "" } });
    if (error) throw new Error(agentErrorMessage(error));
    await get().load();
  },
}));

export function mcpUrls(): { mcpUrl: string; tokenUrl: string } {
  const explicit = process.env.NEXT_PUBLIC_MCP_URL;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const mcpUrl = explicit || (base ? `${base}/functions/v1/mcp` : "https://<project>.supabase.co/functions/v1/mcp");
  const tokenUrl = mcpUrl.replace(/\/functions\/v1\/mcp.*$/, "/functions/v1/agent-token");
  return { mcpUrl, tokenUrl };
}
