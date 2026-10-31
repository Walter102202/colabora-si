// POST /functions/v1/trama-runtime: agents and sign-in for the managed runtime (verify_jwt = false, own secret).
import { randomHex } from '../_shared/agentLogin.ts';
import { oauthError } from '../_shared/errors.ts';
import { createPlatformAgent } from '../_shared/platformAgent.ts';
import { anonClient, denoEnv, serviceClient } from '../_shared/supabase.ts';
import { handleTramaRuntime, type PlatformAgentRow } from './handler.ts';

Deno.serve((req) => {
  const env = denoEnv();
  let service: ReturnType<typeof serviceClient>;
  try {
    service = serviceClient(env);
  } catch {
    return oauthError(500, 'misconfigured', 'The function environment is incomplete.');
  }
  const loginPepper = env.AGENT_LOGIN_PEPPER ?? '';

  return handleTramaRuntime(req, {
    secret: env.TRAMA_RUNTIME_SECRET ?? '',
    loginPepper,
    log: (message) => console.error(message),
    async platformAgents() {
      const { data, error } = await service.from('agents').select('id,workspace_id,auth_user_id,connection,status,revoked_at').eq('is_platform', true);
      if (error) throw error;
      return (data ?? []).map((a): PlatformAgentRow => {
        const nonce = (a.connection as { login_nonce?: unknown } | null)?.login_nonce;
        return {
          id: a.id,
          workspace_id: a.workspace_id,
          auth_user_id: a.auth_user_id,
          login_nonce: typeof nonce === 'string' && nonce ? nonce : null,
          serving: a.status === 'enabled' && !a.revoked_at,
        };
      });
    },
    async workspaces() {
      const { data, error } = await service.from('workspaces').select('id,owner_id');
      if (error) throw error;
      return data ?? [];
    },
    async createAgent(workspaceId, ownerId) {
      const result = await createPlatformAgent(workspaceId, ownerId, {
        loginPepper,
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
          const { data, error } = await service.rpc(fn, args);
          if (error) throw error;
          return data;
        },
        newId: () => crypto.randomUUID(),
        randomSecret: () => randomHex(32),
      });
      return result.agent_id;
    },
    async signIn(email, password) {
      const { data, error } = await anonClient(env).auth.signInWithPassword({ email, password });
      if (error || !data.session) throw error ?? new Error('no session');
      return { access_token: data.session.access_token, expires_in: data.session.expires_in };
    },
  });
});
