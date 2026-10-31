import assert from 'node:assert/strict';
import { handleTelegramWebhook, type WebhookDeps } from './handler.ts';
const msg = { message_id: 3, chat: { id: 12, type: 'private' }, from: { id: 12 }, text: 'approve it' };
function harness() {
  const calls: string[] = []; const sent: Record<string, unknown>[] = [];
  const deps: WebhookDeps = { secret: 'test-secret', appUrl: 'https://app.test', rpc: async (name) => { calls.push(name); return name === 'channel_decide' ? { decision: 'approve', page_id: 'p', task_id: 't' } : {}; }, send: async (_name, body) => { sent.push(body); return { message_id: 4 }; } };
  return { deps, calls, sent };
}
const request = (update: unknown, secret = 'test-secret') => new Request('http://local', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) });
Deno.test('bad signature and oversized body never touch a decision or database', async () => {
  const h = harness();
  assert.equal((await handleTelegramWebhook(request({ update_id: 1, message: msg }, 'wrong'), h.deps)).status, 401);
  assert.equal((await handleTelegramWebhook(request({ update_id: 1, text: 'x'.repeat(66000) }), h.deps)).status, 413);
  assert.deepEqual(h.calls, []);
});
Deno.test('a person telling Trama to approve is ordinary data, not a decision', async () => {
  const h = harness();
  assert.equal((await handleTelegramWebhook(request({ update_id: 1, message: msg }), h.deps)).status, 200);
  assert.deepEqual(h.calls, ['enqueue_channel_update']);
});
Deno.test('groups, forwarded callbacks and voice callbacks cannot decide', async () => {
  for (const extra of [{ chat: { id: 12, type: 'group' } }, { forward_origin: {} }, { voice: { file_id: 'a' } }, { pasted: true }]) {
    const h = harness();
    await handleTelegramWebhook(request({ update_id: 1, callback_query: { id: 'c', from: msg.from, message: { ...msg, ...extra }, data: 'notice:approve' } }), h.deps);
    assert.deepEqual(h.calls, []);
  }
});
Deno.test('callback goes only to the service RPC, then buttons are removed and a task link remains', async () => {
  const h = harness();
  await handleTelegramWebhook(request({ update_id: 1, callback_query: { id: 'c', from: msg.from, message: msg, data: 'notice:approve' } }), h.deps);
  assert.deepEqual(h.calls, ['channel_decide']);
  assert.deepEqual(h.sent.at(-1)?.reply_markup, { inline_keyboard: [] });
  assert.match(String(h.sent.at(-1)?.text), /https:\/\/app.test\/p\/p\?task=t/);
  assert.ok(h.sent.every((s) => !('parse_mode' in s)));
});
Deno.test('an open answer is only a preview until its separate callback', async () => {
  const h = harness();
  await handleTelegramWebhook(request({ update_id: 1, message: { ...msg, reply_to_message: { message_id: 2 } } }), h.deps);
  assert.deepEqual(h.calls, ['channel_answer', 'channel_answer_sent']);
  assert.ok(!h.calls.includes('channel_decide'));
});
Deno.test('semantic denial is acknowledged; a database outage asks Telegram to retry', async () => {
  const h = harness(); h.deps.rpc = async () => { throw { code: 'PT403' }; };
  assert.equal((await handleTelegramWebhook(request({ update_id: 1, message: msg }), h.deps)).status, 200);
  h.deps.rpc = async () => { throw new Error('offline'); };
  assert.equal((await handleTelegramWebhook(request({ update_id: 1, message: msg }), h.deps)).status, 503);
});
