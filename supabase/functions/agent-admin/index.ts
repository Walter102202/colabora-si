// POST /functions/v1/agent-admin: create, revoke or rotate an agent's auth user (verify_jwt = true).
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomHex } from '../_shared/agentLogin.ts';
import { oauthError } from '../_shared/errors.ts';
import { anonClient, callerClient, denoEnv, serviceClient } from '../_shared/supabase.ts';
import { type AgentRecord, type CallerApi, CORS_HEADERS, handleAgentAdmin } from './handler.ts';

export { handleAgentAdmin };

function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

function callerApi(client: SupabaseClient): CallerApi {
  return {
    async canManageWorkspace(workspaceId, userId) {
      const member = unwrap(
        await client.from('workspace_members').select('role')
          .eq('workspace_id', workspaceId).eq('user_id', userId).in('role', ['owner', 'editor']).maybeSingle(),
      );
      if (member) return true;
      const owned = unwrap(
        await client.from('workspaces').select('id').eq('id', workspaceId).eq('owner_id', userId).maybeSingle(),
      );
      return owned !== null;
    },
    // Mirrors ensure_platform_agent (0017): only workspaces.owner_id counts, not a member with the owner role.
    async isWorkspaceOwner(workspaceId, userId) {
      const owned = unwrap(
        await client.from('workspaces').select('id').eq('id', workspaceId).eq('owner_id', userId).maybeSingle(),
      );
      return owned !== null;
    },
    async getPlatformAgent(workspaceId) {
      return unwrap(
        await client.from('agents').select('id, workspace_id, auth_user_id, connection')
          .eq('workspace_id', workspaceId).eq('is_platform', true).is('revoked_at', null).maybeSingle(),
      ) as AgentRecord | null;
    },
    async getAgent(agentId) {
      return unwrap(
        await client.from('agents').select('id, workspace_id, auth_user_id, connection').eq('id', agentId)
          .maybeSingle(),
      ) as AgentRecord | null;
    },
    async rpc(fn, args) {
      return unwrap(await client.rpc(fn, args));
    },
  };
}

Deno.serve((req) => {
  const env = denoEnv();
  let service: SupabaseClient;
  let anon: SupabaseClient;
  try {
    service = serviceClient(env);
    anon = anonClient(env);
  } catch {
    return oauthError(500, 'misconfigured', 'The function environment is incomplete.', CORS_HEADERS);
  }

  return handleAgentAdmin(req, {
    loginPepper: env.AGENT_LOGIN_PEPPER ?? '',
    ciPepper: env.CI_WEBHOOK_PEPPER ?? '',
    // The runtime's SUPABASE_URL may be an internal Docker hostname; prefer the configured public MCP origin.
    functionsBaseUrl: `${new URL(env.MCP_RESOURCE_URL || env.SUPABASE_URL!).origin}/functions/v1`,
    async verifyCaller(token) {
      const { data, error } = await anon.auth.getClaims(token);
      const claims = data?.claims;
      if (error || !claims?.sub || claims.role !== 'authenticated') return null;
      const appMetadata = (claims.app_metadata ?? {}) as { principal_type?: string };
      return { userId: claims.sub, principalType: appMetadata.principal_type ?? 'human', clientId: typeof claims.client_id === 'string' ? claims.client_id : null };
    },
    caller: (token) => callerApi(callerClient(env, token)),
    admin: {
      async createUser(attrs) {
        const { data, error } = await service.auth.admin.createUser(attrs);
        if (error || !data.user) throw error ?? new Error('no user');
        return { id: data.user.id };
      },
      async updateUserById(id, attrs) {
        const { error } = await service.auth.admin.updateUserById(id, attrs);
        if (error) throw error;
      },
      async deleteUser(id) {
        const { error } = await service.auth.admin.deleteUser(id);
        if (error) throw error;
      },
    },
    async serviceRpc(fn, args) {
      return unwrap(await service.rpc(fn, args));
    },
    newId: () => crypto.randomUUID(),
    randomSecret: () => randomHex(32),
  });
});
