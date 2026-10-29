// POST /functions/v1/agent-webhook: webhook agents report back with {op, args} and their own access token
// (verify_jwt = false; the bearer is validated as in mcp). Never the service role: RLS and the RPCs decide.
import { supabaseDb } from '../_shared/db.ts';
import { oauthError } from '../_shared/errors.ts';
import { verifyBearer } from '../_shared/jwt.ts';
import { callerClient, denoEnv } from '../_shared/supabase.ts';
import { taskTools } from '../_shared/tools/tasks.ts';
import { handoverTools } from '../_shared/tools/handover.ts';
import { handleAgentWebhook } from './handler.ts';

export { handleAgentWebhook };

Deno.serve((req) => {
  const env = denoEnv();
  if (!env.SUPABASE_URL) return oauthError(500, 'misconfigured', 'The function environment is incomplete.');
  return handleAgentWebhook(req, {
    verify: (r) => verifyBearer(r, env),
    makeDb: (token, signal) => supabaseDb(callerClient(env, token), signal),
    tools: [...taskTools, ...handoverTools],
    appUrl: (env.APP_URL ?? '').replace(/\/+$/, ''),
  });
});
