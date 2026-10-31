import { denoEnv, serviceClient } from '../_shared/supabase.ts';
import { telegram } from '../_shared/telegram.ts';
import { handleTelegramWebhook } from './handler.ts';
declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };
Deno.serve((req) => {
  const env = denoEnv();
  return handleTelegramWebhook(req, {
    secret: env.TELEGRAM_WEBHOOK_SECRET ?? '', appUrl: env.APP_URL,
    async rpc(name, args) { const { data, error } = await serviceClient(env).rpc(name, args); if (error) throw error; return data ?? {}; },
    send: (method, body) => telegram({ token: env.TELEGRAM_BOT_TOKEN ?? '', base: env.TELEGRAM_API_BASE }, method, body),
    background: (work) => EdgeRuntime.waitUntil(work),
  });
});
