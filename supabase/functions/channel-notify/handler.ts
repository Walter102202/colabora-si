import { timingSafeEqual } from '../_shared/hmac.ts';
import { jsonResponse } from '../_shared/errors.ts';
import { taskUrl } from '../_shared/lib/routes.ts';
import { TelegramError } from '../_shared/telegram.ts';
export interface Notice {
  id: string; lease: string; chat_id: string; task_id: string; page_id: string; agent: string | null; title: string;
  approval: { kind: string; action: string | null; params: Record<string, unknown>; question: string; options: string[] } | null;
}
export function noticeMessage(n: Notice, appUrl: string): Record<string, unknown> {
  const url = new URL(taskUrl(n.page_id, n.task_id), appUrl).href;
  const a = n.approval;
  const detail = a ? `${a.question}\nAction: ${a.action ?? a.kind}\nParameters: ${JSON.stringify(a.params)}` : 'Work is ready for your review. Accept deliveries in the app.';
  const heading = `${n.agent ?? 'An agent'} · ${n.title}\n`;
  const complete = heading.length + detail.length <= 3400;
  const buttons: { text: string; callback_data?: string; url?: string }[][] = [];
  if (a && a.action !== 'payment' && complete) {
    for (const option of a.options) if (['approve', 'reject', 'ignore'].includes(option)) buttons.push([{ text: option[0].toUpperCase() + option.slice(1), callback_data: `${n.id}:${option}` }]);
    if (a.options.includes('respond') && Array.isArray(a.params.choices)) {
      a.params.choices.slice(0, 20).forEach((choice, i) => { if (typeof choice === 'string') buttons.push([{ text: choice.length <= 60 ? choice : `Choice ${i + 1} (see above)`, callback_data: `${n.id}:c:${i}` }]); });
    }
  }
  buttons.push([{ text: 'Open task', url }]);
  const reply = a?.kind !== 'action' && a?.options.includes('respond') && a.action !== 'payment' && complete ? '\nReply to this notice with an answer; confirm it with the button shown next.' : '';
  return { chat_id: n.chat_id, text: `${(heading + detail).slice(0, 3400)}${complete ? reply : '\nOpen the app to review the complete request.'}\n${url}`, reply_markup: { inline_keyboard: buttons }, disable_web_page_preview: true };
}
export interface NotifyDeps {
  secret: string; appUrl: string;
  lease(): Promise<Notice[]>;
  complete(id: string, lease: string, messageId: number | null, retryable: boolean): Promise<void>;
  send(body: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export async function handleChannelNotify(req: Request, deps: NotifyDeps): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
  const supplied = req.headers.get('x-dispatch-secret') ?? '';
  if (!deps.secret || supplied.length > 256 || !timingSafeEqual(supplied, deps.secret)) return jsonResponse(401, { error: 'unauthorized' });
  let sent = 0, failed = 0;
  try {
    for (const notice of await deps.lease()) {
      try {
        const result = await deps.send(noticeMessage(notice, deps.appUrl));
        if (!Number.isSafeInteger(result.message_id) || Number(result.message_id) <= 0) throw new TelegramError(false);
        await deps.complete(notice.id, notice.lease, Number(result.message_id), false); sent++;
      } catch (e) {
        await deps.complete(notice.id, notice.lease, null, e instanceof TelegramError && e.retryable); failed++;
      }
    }
    return jsonResponse(200, { sent, failed });
  } catch { return jsonResponse(503, { error: 'temporarily_unavailable' }); }
}
