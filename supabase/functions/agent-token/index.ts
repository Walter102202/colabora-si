// POST /functions/v1/agent-token: personal access token -> agent access token (verify_jwt = false).
import type { SupabaseClient } from '@supabase/supabase-js';
import { oauthError } from '../_shared/errors.ts';
import { anonClient, denoEnv, serviceClient } from '../_shared/supabase.ts';
import { handleAgentToken, type TokenRow } from './handler.ts';

export { handleAgentToken };

Deno.serve((req) => {
  const env = denoEnv();
  let service: SupabaseClient;
  try {
    service = serviceClient(env);
    anonClient(env);
  } catch {
    return oauthError(500, 'misconfigured', 'The function environment is incomplete.');
  }

  return handleAgentToken(req, {
    loginPepper: env.AGENT_LOGIN_PEPPER ?? '',
    now: () => Date.now(),
    async getPepper() {
      const { data, error } = await service.rpc('agent_token_config');
      if (error) throw error;
      return (data as { pepper?: string } | null)?.pepper ?? '';
    },
    async lookupToken(hash) {
      const { data, error } = await service.rpc('lookup_agent_token', { p_hash: hash });
      if (error) {
        if (error.code === 'PT403' && error.message === 'agent_disabled') throw { code: 'agent_disabled' };
        throw error;
      }
      return (data as TokenRow | null) ?? null;
    },
    async getLoginNonce(agentId) {
      const { data, error } = await service.from('agents').select('connection').eq('id', agentId).maybeSingle();
      if (error) throw error;
      const nonce = (data?.connection as { login_nonce?: unknown } | undefined)?.login_nonce;
      return typeof nonce === 'string' && nonce ? nonce : null;
    },
    async signIn(email, password) {
      const { data, error } = await anonClient(env).auth.signInWithPassword({ email, password });
      if (error || !data.session) throw error ?? new Error('no session');
      return { access_token: data.session.access_token, expires_in: data.session.expires_in };
    },
  });
});
