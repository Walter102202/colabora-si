import { denoEnv, serviceClient } from '../_shared/supabase.ts';
import { telegram } from '../_shared/telegram.ts';
import { handleChannelNotify, type Notice } from './handler.ts';
Deno.serve((req) => {
  const env = denoEnv();
  const rpc = async (name: string, args: Record<string, unknown> = {}) => { const { data, error } = await serviceClient(env).rpc(name, args); if (error) throw error; return data; };
  return handleChannelNotify(req, {
    secret: env.DISPATCH_SECRET ?? '', appUrl: env.APP_URL ?? '',
    lease: async () => await rpc('lease_channel_notices') as Notice[],
    complete: async (id, lease, messageId, retryable) => { await rpc('complete_channel_notice', { p_id: id, p_lease: lease, p_message_id: messageId, p_retryable: retryable }); },
    send: (body) => telegram({ token: env.TELEGRAM_BOT_TOKEN ?? '', base: env.TELEGRAM_API_BASE }, 'sendMessage', body),
  });
});
