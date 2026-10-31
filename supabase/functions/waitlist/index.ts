// POST /functions/v1/waitlist: one email from the public landing (verify_jwt = false). Only this function reaches the
// list, with the service role. The address behind a request is hashed before it leaves this file's reach.
import { oauthError } from '../_shared/errors.ts';
import { hmacSha256Hex } from '../_shared/hmac.ts';
import { denoEnv, MisconfiguredError, serviceClient } from '../_shared/supabase.ts';
import { handleWaitlist, type JoinResult } from './handler.ts';
import { addToNotion } from './notion.ts';

Deno.serve(async (req) => {
  const env = denoEnv();
  try {
    if (!env.APP_URL) throw new MisconfiguredError('APP_URL');
    const { NOTION_TOKEN: token, NOTION_WAITLIST_DATABASE_ID: databaseId } = env;
    return await handleWaitlist(req, {
      appOrigin: new URL(env.APP_URL).origin,
      hashIp: (ip) => hmacSha256Hex(env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEYS ?? '', ip),
      async join(email, ipHash) {
        const { data, error } = await serviceClient(env).rpc('waitlist_join', { p_email: email, p_ip_hash: ipHash });
        if (error) throw error;
        return data as JoinResult;
      },
      async markSynced(id) {
        const { error } = await serviceClient(env).rpc('waitlist_mark_synced', { p_id: id });
        if (error) throw error;
      },
      copyToNotion: token && databaseId ? (email, at) => addToNotion(token, databaseId, email, at) : undefined,
    });
  } catch (err) {
    if (err instanceof MisconfiguredError) return oauthError(500, 'misconfigured', 'The waitlist is not configured.');
    return oauthError(500, 'waitlist_failed', 'The address could not be saved.');
  }
});
