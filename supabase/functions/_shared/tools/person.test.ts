import assert from 'node:assert/strict';
import type { Db, DbResult } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { assistRequest, personTools } from './person.ts';

type Row = Record<string, unknown>;
const tool = (name: string) => personTools.find((t) => t.name === name) as ToolDef;

function harness(result: Row | null = { message_id: 'm', duplicate: false, outcome: { kind: 'for_agent' } }) {
  const calls: { name: string; args: Row }[] = [];
  const db = {
    rpc: <T>(name: string, args: Row): Promise<DbResult<T>> => {
      calls.push({ name, args });
      return Promise.resolve({ data: result as T, error: null });
    },
  } as unknown as Db;
  return { calls, ctx: { db } as unknown as ToolContext };
}

Deno.test('relay passes the channel facts through and defaults to text on Telegram', async () => {
  const h = harness();
  const out = await tool('relay_person_message').handler({ chat_id: '5', message_id: 9, text: 'hola', forwarded: true, quote_message_id: 3 }, h.ctx);
  assert.deepEqual(h.calls, [{ name: 'relay_person_message', args: {
    p_chat_id: '5', p_message_id: 9, p_body: 'hola', p_kind: 'text', p_forwarded: true, p_quote_text: undefined, p_voice_clip_id: undefined,
    p_timezone: undefined, p_channel: 'telegram', p_quote_message_id: 3,
  } }]);
  assert.equal((out.structured as Row).message_id, 'm');
});

Deno.test('only a literal true marks a message as forwarded by the caller', async () => {
  const h = harness();
  await tool('relay_person_message').handler({ chat_id: '5', message_id: 9, text: 'x', forwarded: 'yes' }, h.ctx);
  assert.equal(h.calls[0].args.p_forwarded, false);
});

Deno.test('reply hands the run and the seq to SQL', async () => {
  const h = harness({ channel: 'telegram', chat_id: '5', text: 'hola' });
  const out = await tool('reply_person_message').handler({ run_id: 'r', text: 'hola', through_seq: 7, usage: { input_tokens: 1 } }, h.ctx);
  assert.deepEqual(h.calls[0], { name: 'reply_person_message', args: { p_run_id: 'r', p_text: 'hola', p_through_seq: 7, p_usage: { input_tokens: 1 } } });
  assert.equal((out.structured as Row).chat_id, '5');
});

Deno.test('the skill hands the run, the message and the wording to SQL, and a refusal is an answer', async () => {
  const h = harness({ saved: false, reason: 'not_requested', hint: 'No guardé nada.' });
  const out = await tool('save_to_notes').handler({ run_id: 'r', message_id: 'm', text: 'hola' }, h.ctx);
  assert.deepEqual(h.calls[0], { name: 'save_to_notes', args: { p_run_id: 'r', p_message_id: 'm', p_text: 'hola' } });
  assert.equal(out.text, 'Not saved.');
  assert.equal((out.structured as Row).reason, 'not_requested');
});

Deno.test('assistRequest returns the thread as it came', async () => {
  const h = harness({ kind: 'assist', task_id: 't', messages: [], through_seq: null });
  const out = await assistRequest('t', h.ctx);
  assert.equal((out.structured as Row).kind, 'assist');
  assert.deepEqual(h.calls[0], { name: 'assist_request_context', args: { p_task_id: 't' } });
});

Deno.test('neither tool is offered as read-only', () => {
  for (const t of personTools) assert.notEqual(t.annotations?.readOnlyHint, true);
});
