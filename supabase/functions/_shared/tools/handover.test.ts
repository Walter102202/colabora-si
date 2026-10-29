import assert from 'node:assert/strict';
import { type Db, type DbResult, ToolError } from '../db.ts';
import { validate } from '../jsonSchema.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { WORLD_TOOLS } from '../../../../agent/test/stub-world-tools.mjs';
import { CHECKPOINT_VERSION, handoverTools } from './handover.ts';
import { taskTools } from './tasks.ts';
import { waitTools } from './wait.ts';
import { readTools } from './read.ts';
import { writeTools } from './write.ts';

type Row = Record<string, unknown>;
const tool = (name: string) => handoverTools.find((t) => t.name === name) as ToolDef;

function ctxWith(rpc: (fn: string, args: Row) => Promise<DbResult<unknown>>): ToolContext {
  const db: Db = { rpc: <T>(fn: string, args: Row) => rpc(fn, args) as Promise<DbResult<T>>, select: () => Promise.resolve({ data: [], error: null }) };
  return { db, principal: { type: 'agent', userId: 'u-agent', agentId: 'agent-1', workspaceId: 'w1', clientId: null },
    signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: () => Promise.resolve(), progress: () => {} };
}
const cp = { v: CHECKPOINT_VERSION, next_step: 'Write section 2', ops: { confirmed: [], pending: [{ key: 'k1', tool: 'append_blocks' }] } };

Deno.test('save_checkpoint passes run_id, checkpoint and idempotency_key to the RPC', async () => {
  const calls: [string, Row][] = [];
  const ctx = ctxWith((fn, args) => { calls.push([fn, args as Row]); return Promise.resolve({ data: { activity_id: 'a1', seq: 7, replayed: false }, error: null }); });
  const out = await tool('save_checkpoint').handler({ run_id: 'r1', checkpoint: cp, idempotency_key: 'r1:cp:0' }, ctx);
  assert.deepEqual(calls, [['save_checkpoint', { p_run_id: 'r1', p_checkpoint: cp, p_idempotency_key: 'r1:cp:0' }]]);
  assert.equal(out.structured.seq, 7);
});

Deno.test('the checkpoint schema requires v and next_step and rejects unknown keys', () => {
  const schema = tool('save_checkpoint').inputSchema;
  assert.deepEqual(validate(schema, { run_id: 'r1', checkpoint: cp, idempotency_key: 'k' }), []);
  assert.ok(validate(schema, { run_id: 'r1', checkpoint: { v: 1 }, idempotency_key: 'k' }).length > 0);
  assert.ok(validate(schema, { run_id: 'r1', checkpoint: { ...cp, extra: true }, idempotency_key: 'k' }).length > 0);
});

Deno.test('hand_over requires a handover_note and reports the task state', async () => {
  assert.ok(validate(tool('hand_over').inputSchema, { run_id: 'r1', checkpoint: cp, idempotency_key: 'k' }).length > 0);
  const ctx = ctxWith(() => Promise.resolve({ data: { activity_id: 'a2', seq: 8, task_state: 'input_required', replayed: false }, error: null }));
  const out = await tool('hand_over').handler({ run_id: 'r1', checkpoint: { ...cp, handover_note: 'Closing the session' }, idempotency_key: 'r1:handover' }, ctx);
  assert.equal(out.structured.task_state, 'input_required');
  assert.match(out.text, /input_required/);
});

Deno.test('checkpoint_version_unsupported and resume_unsupported reach the model with a message', async () => {
  for (const code of ['checkpoint_version_unsupported', 'resume_unsupported']) {
    const ctx = ctxWith(() => Promise.resolve({ data: null, error: { code: 'PT422', message: code } }));
    await assert.rejects(() => tool('save_checkpoint').handler({ run_id: 'r1', checkpoint: cp, idempotency_key: 'k' }, ctx),
      (err: unknown) => err instanceof ToolError && err.code === code && err.message.length > 10);
  }
});

Deno.test('the stub world offers the same tool inputs as the server', () => {
  const server = new Map([...readTools, ...writeTools, ...taskTools, ...waitTools, ...handoverTools].map((t) => [t.name, t.inputSchema]));
  for (const w of WORLD_TOOLS as { name: string; inputSchema: Row }[]) {
    const s = server.get(w.name) as Row | undefined;
    assert.ok(s, `server has no tool ${w.name}`);
    assert.deepEqual(Object.keys(w.inputSchema.properties as Row).sort(), Object.keys(s.properties as Row).sort(), `properties of ${w.name}`);
    assert.deepEqual([...((w.inputSchema.required as string[]) ?? [])].sort(), [...((s.required as string[]) ?? [])].sort(), `required of ${w.name}`);
  }
});
