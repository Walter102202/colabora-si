import assert from 'node:assert/strict';
import { type Db, type DbResult, ToolError } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { aiTools } from './ai.ts';
import { readTools } from './read.ts';
import { inlineMarkdownToSpans } from '../lib/agentInput.ts';

type Row = Record<string, unknown>;
const tool = (name: string) => aiTools.find((t) => t.name === name) as ToolDef;
const database = {
  id: 'database-data', properties: [
    { id: 'title', name: 'Task', type: 'text' }, { id: 'notes', name: 'Notes', type: 'text' },
    { id: 'p_ai', name: 'Summary', type: 'ai' },
  ],
  rows: [{ id: 'r1', pageId: 'row1', cells: { title: 'Acme', notes: 'Slow onboarding', p_ai: { text: 'Short', by: 'agent', id: 'u', at: 1 } } }], views: [],
};
const fill = { id: 't1', request_kind: 'fill', request: { page_id: 'db', property_id: 'p_ai', property_name: 'Summary', prompt: 'Summarize', row_ids: ['r1'], inputs: null, remaining: 0 } };

function harness(task: Row = fill, page: Row = { id: 'db', title: 'Feedback', blocks: [], database }) {
  const calls: { name: string; args: Row }[] = [];
  const db: Db = {
    rpc: <T>(name: string, args: Row): Promise<DbResult<T>> => {
      calls.push({ name, args });
      return Promise.resolve({ data: (name === 'get_page_bundle' ? { page, pages: {} } : { task_state: 'done' }) as T, error: null });
    },
    select: <T>(spec: { table: string }): Promise<DbResult<T[]>> => Promise.resolve({ data: (spec.table === 'agent_tasks' ? [task] : []) as T[], error: null }),
  };
  const ctx: ToolContext = { db, principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w', clientId: null },
    signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: async () => {}, progress: () => {} };
  return { ctx, calls };
}

Deno.test('get_ai_request returns the rows with their input values', async () => {
  const h = harness();
  const out = await tool('get_ai_request').handler({ task_id: 't1' }, h.ctx);
  assert.deepEqual(out.structured.rows, [{ row_id: 'r1', rev: 0, title: 'Acme', inputs: { Task: 'Acme', Notes: 'Slow onboarding' } }]);
  const limited = harness({ ...fill, request: { ...fill.request, inputs: ['notes'] } });
  const subset = await tool('get_ai_request').handler({ task_id: 't1' }, limited.ctx);
  assert.deepEqual((subset.structured.rows as Row[])[0].inputs, { Notes: 'Slow onboarding' });
});
Deno.test('get_ai_request refuses a work task', async () => {
  await assert.rejects(() => tool('get_ai_request').handler({ task_id: 't1' }, harness({ ...fill, request_kind: null }).ctx),
    (error: unknown) => error instanceof ToolError && error.code === 'not_a_request');
});
Deno.test('fill_ai_cells passes the values to set_ai_cells', async () => {
  const h = harness(), values = [{ row_id: 'r1', text: 'Short', rev: 0 }];
  await tool('fill_ai_cells').handler({ run_id: 'run', values, idempotency_key: 'key' }, h.ctx);
  assert.deepEqual(h.calls, [{ name: 'set_ai_cells', args: { p_run_id: 'run', p_values: values, p_idempotency_key: 'key' } }]);
});
Deno.test('complete_ai_request passes summary and usage', async () => {
  const h = harness(), usage = { input_tokens: 1, output_tokens: 2, model: 'model', cost_usd: 0.1 };
  await tool('complete_ai_request').handler({ run_id: 'run', summary: 'Filled', usage }, h.ctx);
  assert.deepEqual(h.calls, [{ name: 'complete_ai_request', args: { p_run_id: 'run', p_summary: 'Filled', p_usage: usage } }]);
});
Deno.test('read tools show an ai cell as its text', async () => {
  const read = readTools.find((t) => t.name === 'query_database')!;
  const out = await read.handler({ database_id: 'db' }, harness().ctx);
  assert.equal(((out.structured.rows as Row[])[0].cells as Row).Summary, 'Short');
});
Deno.test('get_ai_request returns the block as inline Markdown', async () => {
  const h = harness({ id: 'rewrite', request_kind: 'rewrite', request: { page_id: 'page', block_id: 'b1', instruction: 'Shorter', selection: 'long' } },
    { id: 'page', blocks: [{ id: 'b1', type: 'paragraph', html: 'Our <b>long</b> intro', rev: 3 }] });
  const out = await tool('get_ai_request').handler({ task_id: 'rewrite' }, h.ctx);
  assert.deepEqual(out.structured.block, { id: 'b1', type: 'paragraph', text: 'Our **long** intro', rev: 3 });
});
Deno.test('apply_ai_rewrite turns Markdown into spans', async () => {
  const h = harness();
  await tool('apply_ai_rewrite').handler({ run_id: 'run', markdown: 'A **short** intro', rev: 3, idempotency_key: 'rewrite:t' }, h.ctx);
  assert.deepEqual(h.calls, [{ name: 'apply_ai_rewrite', args: { p_run_id: 'run', p_spans: inlineMarkdownToSpans('A **short** intro'),
    p_rev: 3, p_usage: undefined, p_idempotency_key: 'rewrite:t' } }]);
});
