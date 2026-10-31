import assert from 'node:assert/strict';
import type { Db, DbResult } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { aiTools } from './ai.ts';
import { lessonTools } from './lessons.ts';

type Row = Record<string, unknown>;
const tool = (name: string, tools = lessonTools) => tools.find((t) => t.name === name) as ToolDef;

function ctxWith(rpc: (fn: string, args: Row) => DbResult<unknown>, rows: Row[] = []): ToolContext {
  const db: Db = {
    download: () => Promise.resolve({ data: null, error: null }),
    rpc: <T>(fn: string, args: Row) => Promise.resolve(rpc(fn, args)) as Promise<DbResult<T>>,
    select: <T>() => Promise.resolve({ data: rows as T[], error: null }),
  };
  return { db, principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w1', clientId: null },
    signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: () => Promise.resolve(), progress: () => {} };
}

Deno.test('propose_lesson passes what the agent wrote and nothing about the source', async () => {
  const calls: [string, Row][] = [];
  const ctx = ctxWith((fn, args) => { calls.push([fn, args]); return { data: { lesson_id: 'l1', status: 'proposed' }, error: null }; });
  const out = await tool('propose_lesson').handler({ run_id: 'r', text: 'Dates are DD/MM/YYYY', idempotency_key: 'k' }, ctx);
  assert.equal(calls[0][0], 'propose_lesson');
  assert.equal(calls[0][1].p_example, '');
  assert.equal(calls[0][1].p_idempotency_key, 'k');
  assert.equal(out.structured.lesson_id, 'l1');
});

Deno.test('get_ai_request reads a lesson request through its RPC, without touching a page', async () => {
  const fns: string[] = [];
  const ctx = ctxWith((fn) => { fns.push(fn); return { data: { kind: 'lesson', corrections: [{ text: 'x' }] }, error: null }; },
    [{ id: 't1', request_kind: 'lesson', request: { task_id: 'source' } }]);
  const out = await tool('get_ai_request', aiTools).handler({ task_id: 't1' }, ctx);
  assert.deepEqual(fns, ['lesson_request_context']);
  assert.equal(out.structured.kind, 'lesson');
});
