// What a person tells the workspace agent on a chat channel, the agent's answer, and its save skill. These are runtime
// tools: the platform loop hides them from the model's normal tool list (REQUEST_TOOLS), and the SQL behind them refuses
// any other agent. The assist turn offers save_to_notes to the model only when a person's message asked to save.
import { must, ToolError } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { num, object, output, str, WRITE } from './common.ts';

const usage = object({
  input_tokens: { type: 'integer', minimum: 0 }, output_tokens: { type: 'integer', minimum: 0 },
  model: { type: 'string' }, cost_usd: { type: 'number', minimum: 0 },
});

const relay: ToolDef = {
  name: 'relay_person_message', title: 'Relay a person\'s message',
  description: 'Platform loop tool: hands over one message a person sent on a chat channel. Set forwarded from the channel\'s own metadata.',
  inputSchema: object({
    chat_id: { type: 'string', minLength: 1, maxLength: 32 },
    message_id: { type: 'integer', minimum: 1 },
    text: { type: 'string', minLength: 1, maxLength: 20000 },
    kind: { type: 'string', enum: ['text', 'voice'] },
    forwarded: { type: 'boolean' },
    quote_text: { type: 'string', maxLength: 20000 },
    voice_clip_id: { type: 'string', minLength: 1 },
    timezone: { type: 'string', maxLength: 64 },
    quote_message_id: { type: 'integer', minimum: 1 },
    channel: { type: 'string', enum: ['telegram', 'whatsapp'] },
  }, ['chat_id', 'message_id', 'text']),
  outputSchema: output({ message_id: { type: 'string' }, duplicate: { type: 'boolean' }, outcome: { type: 'object' }, reply: { type: 'string' } }),
  annotations: WRITE, cacheTtlMs: 0,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Record<string, unknown>>('relay_person_message', {
      p_chat_id: str(args.chat_id), p_message_id: num(args.message_id), p_body: str(args.text), p_kind: args.kind ?? 'text',
      p_forwarded: args.forwarded === true, p_quote_text: args.quote_text, p_voice_clip_id: args.voice_clip_id, p_timezone: args.timezone,
      p_channel: args.channel ?? 'telegram', p_quote_message_id: num(args.quote_message_id),
    }));
    return { text: 'Message handed over.', structured: data ?? {} };
  },
};

const reply: ToolDef = {
  name: 'reply_person_message', title: 'Answer a person',
  description: 'Platform loop tool: answers everything up to through_seq and closes the request.',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1, maxLength: 4000 }, through_seq: { type: 'integer', minimum: 0 }, usage, propose_message_id: { type: 'string', minLength: 1 },
  }, ['run_id', 'text', 'through_seq']),
  outputSchema: output({ channel: { type: 'string' }, chat_id: { type: 'string' }, text: { type: 'string' }, message_id: { type: 'string' }, note_page_id: { type: 'string' } }),
  annotations: WRITE, cacheTtlMs: 0,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Record<string, unknown>>('reply_person_message', {
      p_run_id: str(args.run_id), p_text: str(args.text), p_through_seq: num(args.through_seq), p_usage: args.usage, ...(args.propose_message_id ? { p_propose_message_id: str(args.propose_message_id) } : {}),
    }));
    return { text: 'Answered.', structured: data ?? {} };
  },
};

const save: ToolDef = {
  name: 'save_to_notes', title: 'Save to the person\'s notes',
  description: 'Platform loop tool: saves to the notes of the person who asked. Names the message that asked; the server checks that message and refuses anything else. Leave text out to save what the server resolved.',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 }, message_id: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1, maxLength: 20000 },
  }, ['run_id', 'message_id']),
  outputSchema: output({
    saved: { type: 'boolean' }, duplicate: { type: 'boolean' }, note_id: { type: 'string' }, page_id: { type: 'string' }, reason: { type: 'string' }, hint: { type: 'string' },
  }),
  annotations: WRITE, cacheTtlMs: 0,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Record<string, unknown>>('save_to_notes', {
      p_run_id: str(args.run_id), p_message_id: str(args.message_id), p_text: args.text,
    }));
    return { text: data?.saved ? 'Saved.' : 'Not saved.', structured: data ?? {} };
  },
};

/** get_ai_request for an `assist` task: the thread, as data. */
export async function assistRequest(taskId: string, ctx: ToolContext) {
  const data = await must(ctx.db.rpc<Record<string, unknown>>('assist_request_context', { p_task_id: taskId }));
  if (!data) throw new ToolError('not_found', 'The request was not found.');
  return { text: 'Thread ready.', structured: data };
}

const deliveries: ToolDef = {
  name: 'deliver_person_replies', title: 'Deliver pending replies',
  description: 'Platform runtime only: reads persisted channel replies, or acknowledges one after delivery.',
  inputSchema: object({ ack_message_id: { type: 'string', minLength: 1 } }, []),
  outputSchema: output({ messages: { type: 'array' } }),
  annotations: WRITE, cacheTtlMs: 0,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Record<string, unknown>>('deliver_person_replies', { p_ack_message_id: args.ack_message_id }));
    return { text: 'Pending replies.', structured: data ?? {} };
  },
};

export const personTools: ToolDef[] = [relay, reply, save, deliveries];
