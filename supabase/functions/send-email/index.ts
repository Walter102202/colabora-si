import { deliverAccountLink } from '../_shared/accountEmail.ts';
import { sha256Hex, timingSafeEqual } from '../_shared/hmac.ts';
import { denoEnv, serviceClient } from '../_shared/supabase.ts';
import { readAccountBody } from '../account-link/handler.ts';

// Workspace invitations only. Auth SMTP, templates and Send Email Hook are not used.
Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const env = denoEnv();
  if (!env.RESEND_API_KEY || !env.APP_URL) return new Response('Server misconfigured', { status: 503 });
  try {
    const sb = serviceClient(env);
    // Keep pg_net authentication; delivery configuration moves out of the database.
    const { data: cfg, error: configError } = await sb.rpc('email_config');
    if (configError || !cfg?.cron_secret || !timingSafeEqual(req.headers.get('x-push-secret') ?? '', cfg.cron_secret)) return new Response(null, { status: 401 });
    const raw = await readAccountBody(req);
    if (raw === null) return new Response(null, { status: 413 });
    let input;
    try { input = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
    if (typeof input?.invitation_id !== 'string' || typeof input?.token !== 'string') return new Response(null, { status: 400 });
    const { data: invitation, error } = await sb.from('workspace_invitations').select('email,token_hash').eq('id', input.invitation_id).maybeSingle();
    if (error || !invitation || !timingSafeEqual(await sha256Hex(input.token), invitation.token_hash)) return new Response(null, { status: 400 });
    const { data: target, error: lookupError } = await sb.rpc('account_link_target', { p_email: invitation.email, p_invite: input.token });
    if (lookupError || !target?.workspace) return new Response(null, { status: 400 });
    // Only this authenticated path may create an account, after invite_member reserved its slot.
    await deliverAccountLink(sb.auth.admin, env.RESEND_API_KEY, env.APP_URL, invitation.email, target, input.token);
    return Response.json({});
  } catch { console.error('workspace_email_failed'); return new Response(null, { status: 502 }); }
});
