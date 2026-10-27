// POST /functions/v1/agent-dispatch: invoked by pg_cron through pg_net with x-dispatch-secret (verify_jwt = false).
// One of the few functions with the secret key: it drains the dispatch queue with service_role RPCs.
import type { SupabaseClient } from '@supabase/supabase-js';
import { oauthError } from '../_shared/errors.ts';
import { denoEnv, serviceClient } from '../_shared/supabase.ts';
import { type DispatchMessage, handleAgentDispatch } from './handler.ts';

export { handleAgentDispatch };

Deno.serve((req) => {
  const env = denoEnv();
  let service: SupabaseClient;
  try {
    service = serviceClient(env);
  } catch {
    return oauthError(500, 'misconfigured', 'The function environment is incomplete.');
  }
  const mcpUrl = env.MCP_RESOURCE_URL || `${(env.SUPABASE_URL ?? '').replace(/\/+$/, '')}/functions/v1/mcp`;
  return handleAgentDispatch(req, {
    secret: env.DISPATCH_SECRET ?? '',
    mcpUrl,
    now: () => Date.now(),
    fetch: (input, init) => fetch(input, init),
    async dequeue(batch, vt) {
      const { data, error } = await service.rpc('dispatch_dequeue', { p_batch: batch, p_vt: vt });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as DispatchMessage[];
    },
    async ack({ msgId, eventId, ok, error, retryable }) {
      const { error: err } = await service.rpc('dispatch_ack', {
        p_msg_id: msgId,
        p_event_id: eventId,
        p_ok: ok,
        p_error: error ?? null,
        p_retryable: retryable ?? true,
      });
      if (err) throw err;
    },
  });
});
