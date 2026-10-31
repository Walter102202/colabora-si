// Telegram errors never expose URLs (which contain the bot token) or provider bodies.
export class TelegramError extends Error {
  constructor(readonly retryable: boolean) { super('Telegram delivery failed'); }
}
export interface TelegramConfig { token: string; base?: string; fetch?: typeof fetch }
export async function telegram(config: TelegramConfig, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!config.token) throw new TelegramError(false);
  let res: Response;
  try {
    res = await (config.fetch ?? fetch)(`${config.base ?? 'https://api.telegram.org'}/bot${config.token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
  } catch { throw new TelegramError(false); } // Unknown delivery outcome: explicit /pending is safer than duplicate automatic sends.
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new TelegramError(res.status === 429 || res.status >= 500);
  return data.result ?? {};
}

export function workText(data: Record<string, unknown>): string {
  const work = Array.isArray(data.running_work) ? data.running_work : [];
  if (!work.length) return 'No open work is visible for you.';
  return work.map((t) => `${t.title} — ${t.agent ?? 'Unassigned'}: ${t.state}${t.waiting_on ? ` (waiting on ${t.waiting_on})` : ''}; subtasks ${t.subtasks_done}/${t.subtasks_total}${t.stopped ? '; stopped' : ''}`).join('\n').slice(0, 3900);
}
