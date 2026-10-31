import assert from 'node:assert/strict';
import { handleChannelNotify, noticeMessage, type Notice } from './handler.ts';
import { TelegramError } from '../_shared/telegram.ts';
const base: Notice = { id: '00000000-0000-4000-8000-000000000001', lease: 'l', chat_id: '1', task_id: 't', page_id: 'p', agent: 'Worker', title: 'Task', approval: { kind: 'action', action: 'publish', params: { destination: 'saved' }, question: 'Publish?', options: ['approve', 'reject', 'edit'] } };
Deno.test('buttons are rendered from saved options and edit is excluded', () => {
  const body = noticeMessage(base, 'https://app.test');
  const json = JSON.stringify(body);
  assert.match(json, /approve/); assert.ok(!json.includes(':edit')); assert.ok(!('parse_mode' in body));
  assert.match(String(body.text), /destination.*saved/);
  const rows = (body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
  for (const row of rows) for (const b of row) if (b.callback_data) assert.ok(new TextEncoder().encode(b.callback_data).length <= 64);
});
Deno.test('payment, delivery acceptance and incomplete large requests have only the app link', () => {
  for (const approval of [null, { ...base.approval!, action: 'payment' }, { ...base.approval!, question: 'x'.repeat(4000) }]) {
    const json = JSON.stringify(noticeMessage({ ...base, approval }, 'https://app.test'));
    assert.ok(!json.includes('callback_data')); assert.match(json, /Open task/);
  }
});
Deno.test('dispatch authentication precedes leasing and delivery failures are bounded by server ack', async () => {
  const acks: unknown[] = []; let leases = 0;
  const deps = { secret: 's', appUrl: 'https://app.test', lease: async () => { leases++; return [base]; }, send: async () => { throw new TelegramError(true); }, complete: async (...args: unknown[]) => { acks.push(args); } };
  assert.equal((await handleChannelNotify(new Request('http://local', { method: 'POST' }), deps)).status, 401); assert.equal(leases, 0);
  assert.equal((await handleChannelNotify(new Request('http://local', { method: 'POST', headers: { 'x-dispatch-secret': 's' } }), deps)).status, 200);
  assert.deepEqual(acks, [[base.id, base.lease, null, true]]);
});
