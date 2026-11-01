import { deliverAccountLink } from '../_shared/accountEmail.ts';
import { hmacSha256Hex } from '../_shared/hmac.ts';
import { denoEnv, serviceClient } from '../_shared/supabase.ts';
import { handleAccountLink } from './handler.ts';

declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };
Deno.serve((req) => {
  const env = denoEnv();
  if (!env.APP_URL || !env.RESEND_API_KEY) return new Response(null, { status: 503 });
  const sb = serviceClient(env);
  return handleAccountLink(req, {
    appOrigin: new URL(env.APP_URL).origin,
    background: (work) => EdgeRuntime.waitUntil(work),
    async allowed(email, ip) {
      const secret = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEYS ?? '';
      const [ipHash, emailHash] = await Promise.all([hmacSha256Hex(secret, ip), hmacSha256Hex(secret, email)]);
      const { data, error } = await sb.rpc('account_link_allowed', { p_ip_hash: ipHash, p_email_hash: emailHash });
      if (error) throw new Error('account_limit_failed');
      return data === true;
    },
    async lookup(email, invite) {
      const { data, error } = await sb.rpc('account_link_target', { p_email: email, p_invite: invite });
      if (error) throw new Error('account_lookup_failed');
      return data;
    },
    send: (email, target, invite) => deliverAccountLink(sb.auth.admin, env.RESEND_API_KEY!, env.APP_URL!, email, target, invite),
  });
});
