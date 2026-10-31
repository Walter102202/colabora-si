import { taskUrl } from '../_shared/lib/routes.ts';
import { timingSafeEqual } from '../_shared/hmac.ts';
import { jsonResponse } from '../_shared/errors.ts';
import { workText } from '../_shared/telegram.ts';

export interface WebhookDeps {
  secret: string;
  appUrl?: string;
  rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  send(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  background?: (work: Promise<unknown>) => void;
}
const MAX_BODY = 64 * 1024;
const id = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const isForwarded = (msg: Record<string, unknown>) => Boolean(msg.forward_origin || msg.forward_date || msg.pasted);

export async function handleTelegramWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
  const supplied = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!deps.secret || supplied.length > 256 || !timingSafeEqual(supplied, deps.secret)) return jsonResponse(401, { error: 'unauthorized' });
  if (Number(req.headers.get('content-length')) > MAX_BODY) return jsonResponse(413, { error: 'too_large' });
  const reader = req.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  if (!reader) return jsonResponse(400, { error: 'invalid_update' });
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > MAX_BODY) { await reader.cancel(); return jsonResponse(413, { error: 'too_large' }); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  let update;
  try { const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; } update = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return jsonResponse(400, { error: 'invalid_update' }); }
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return jsonResponse(400, { error: 'invalid_update' });
  const callback = update.callback_query;
  const msg = callback?.message ?? update.message;
  const from = callback?.from ?? msg?.from;
  const chat = id(msg?.chat?.id), person = id(from?.id), message = id(msg?.message_id);
  if (!chat || !person || !message || msg.chat.type !== 'private' || from.is_bot) return jsonResponse(200, { ok: true });
  const later = async (work: Promise<unknown>) => { const safe = work.catch(() => {}); if (deps.background) deps.background(safe); else await safe; };
  try {
    if (callback) {
      if (isForwarded(msg) || msg.voice || typeof callback.data !== 'string') return jsonResponse(200, { ok: true });
      const result = await deps.rpc('channel_decide', { p_chat_id: chat, p_from_id: person, p_message_id: Number(message), p_callback: callback.data });
      await later((async () => {
        await deps.send('answerCallbackQuery', { callback_query_id: callback.id, text: `Recorded: ${result.decision}` });
        await deps.send('editMessageText', { chat_id: chat, message_id: Number(message), text: `Recorded: ${result.decision}.
${new URL(taskUrl(String(result.page_id), String(result.task_id)), deps.appUrl ?? "https://colabora.si").href}`, reply_markup: { inline_keyboard: [] } });
      })());
    } else if (typeof msg.text === 'string' && /^\/start\s+[a-f0-9]{48}$/.test(msg.text) && !isForwarded(msg)) {
      await deps.rpc('redeem_channel_link', { p_code: msg.text.split(/\s+/)[1], p_chat_id: chat, p_from_id: person });
      await later(deps.send('sendMessage', { chat_id: chat, text: 'Telegram is connected. Decisions use verified buttons; payment, edits and delivery acceptance stay in the app.' }));
    } else if (msg.text === '/pending' && !isForwarded(msg)) {
      const result = await deps.rpc('channel_pending', { p_chat_id: chat, p_from_id: person });
      await later(deps.send('sendMessage', { chat_id: chat, text: `${result.pending} pending notices will be sent again.` }));
    } else if (msg.text === '/status' && !isForwarded(msg)) {
      const result = await deps.rpc('channel_work_status', { p_chat_id: chat, p_from_id: person });
      await later(deps.send('sendMessage', { chat_id: chat, text: workText(result) }));
    } else {
      let drafted = false;
      if (msg.reply_to_message && typeof msg.text === 'string' && !isForwarded(msg) && !msg.voice) {
        try {
          const draft = await deps.rpc('channel_answer', { p_chat_id: chat, p_from_id: person, p_message_id: msg.reply_to_message.message_id, p_text: msg.text });
          drafted = true;
          await later((async () => {
            const sent = await deps.send('sendMessage', { chat_id: chat, text: `Confirm this answer:\n${draft.text}`, reply_markup: { inline_keyboard: [[{ text: 'Send this answer', callback_data: `${draft.id}:r:${draft.nonce}` }]] } });
            await deps.rpc('channel_answer_sent', { p_id: draft.id, p_nonce: draft.nonce, p_message_id: sent.message_id });
          })());
        } catch (e) { if ((e as { message?: string }).message !== 'answer_not_available') throw e; }
      }
      if (!drafted) await deps.rpc('enqueue_channel_update', { p_update_id: update.update_id, p_chat_id: chat, p_from_id: person, p_message: msg });
    }
    return jsonResponse(200, { ok: true });
  } catch (e) {
    if (/^PT4|42501/.test((e as { code?: string }).code ?? '')) {
      if (callback) await later(deps.send('answerCallbackQuery', { callback_query_id: callback.id, text: 'This action is unavailable. Open the task in the app.' }));
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(503, { error: 'temporarily_unavailable' });
  }
}
