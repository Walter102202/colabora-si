// POST /functions/v1/mcp: remote MCP endpoint (verify_jwt = false; the bearer is validated in _shared/jwt.ts).
// Every database call runs with a client built from the caller's token, so RLS decides; never the service role.
import { supabaseDb } from '../_shared/db.ts';
import { oauthError } from '../_shared/errors.ts';
import { resolveLinkedSession, verifyBearer } from '../_shared/jwt.ts';
import { handleMcp } from '../_shared/mcp.ts';
import { callerClient, denoEnv } from '../_shared/supabase.ts';
import { buildServer } from './server.ts';

const server = buildServer();

Deno.serve(async (req) => {
  const env = denoEnv();
  if (!env.SUPABASE_URL) return oauthError(500, 'misconfigured', 'The function environment is incomplete.');
  return await handleMcp(req, server, {
    env,
    verify: async (r) => {
      const bearer = await verifyBearer(r, env);
      return resolveLinkedSession(bearer, async () => {
        const { data, error } = await callerClient(env, bearer.token).rpc('session_identity');
        return { data: data as Record<string, unknown> | null, error };
      });
    },
    makeDb: (token, signal) => supabaseDb(callerClient(env, token), signal),
  });
});
