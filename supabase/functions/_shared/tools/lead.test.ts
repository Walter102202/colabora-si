import assert from 'node:assert/strict';
import { briefBlocks, BRIEF_KEYS, leadTools } from './lead.ts';
import { type Db, type DbResult, ToolError } from '../db.ts';
import type { ToolContext } from '../mcp.ts';

type Row = Record<string, unknown>;
const tool = (name: string) => {
  const found = leadTools.find((t) => t.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
};
function context(rpc: (fn: string, args: Row) => DbResult<unknown>): ToolContext {
  const db: Db = {
    rpc: <T>(fn: string, args: Row) => Promise.resolve(rpc(fn, args) as DbResult<T>),
    select: <T>() => Promise.resolve({ data: [{ db_page_id: 'db1' }] as T[], error: null }),
    download: async () => ({ data: null, error: null }),
  };
  return { db, principal: { type: 'agent', userId: 'u1', agentId: 'lead1', workspaceId: 'w1', clientId: null },
    signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: async () => {}, progress: () => {} };
}

Deno.test('update_subtask sends only supplied fields and returns the new version', async () => {
  const patches = [{ objective: 'Revised goal' }, { delegate_agent_id: 'worker2', depends_on_task_ids: ['t2', 't3'] }];
  for (const patch of patches) {
    const calls: Row[] = [];
    const ctx = context((fn, args) => { calls.push({ fn, args }); return { data: 4, error: null }; });
    const result = await tool('update_subtask').handler({ task_id: 't1', ...patch }, ctx);
    assert.deepEqual(calls, [{ fn: 'update_brief', args: { p_task_id: 't1', p_patch: patch } }]);
    assert.deepEqual(result.structured, { brief_version: 4 });
  }
});

Deno.test('update_subtask rejects an empty patch before writing', async () => {
  const ctx = context(() => { assert.fail('must not write'); });
  await assert.rejects(() => tool('update_subtask').handler({ task_id: 't1' }, ctx),
    (error: unknown) => error instanceof ToolError && error.code === 'invalid_input');
});

// The app's briefFromRow reads brief sections by block key, so create_task must write the same keys as the row template.
Deno.test('briefBlocks keys its section headings like the Task brief template', () => {
  const blocks = briefBlocks('Map needs', ['Three segments listed', 'Sources cited'], 'No external calls', ['https://x.test']);
  const keyed = blocks.filter((b) => b.key).map((b) => [b.type, b.key]);
  assert.deepEqual(keyed, [
    ['heading2', 'brief:goal'], ['heading2', 'brief:done_when'], ['heading2', 'brief:constraints'], ['heading2', 'brief:sources'],
  ]);
  assert.deepEqual(Object.values(BRIEF_KEYS), keyed.map(([, k]) => k));
  const under = (key: string) => {
    const rest = blocks.slice(blocks.findIndex((b) => b.key === key) + 1);
    const next = rest.findIndex((b) => b.key);
    return next === -1 ? rest : rest.slice(0, next);
  };
  assert.deepEqual(under('brief:done_when').map((b) => b.type), ['todo', 'todo']);
  assert.deepEqual(under('brief:sources').map((b) => b.spans), [['https://x.test']]);
});

Deno.test('review_task and close_subtask describe the reviewer path without changing their schema', () => {
  const review = leadTools.find((t) => t.name === 'review_task')!;
  const close = leadTools.find((t) => t.name === 'close_subtask')!;
  assert.match(review.description, /review_of/);
  assert.match(close.description, /reviewer/);
  assert.deepEqual(Object.keys(review.inputSchema.properties ?? {}), ['task_id', 'run_id', 'artifact_id', 'verdict', 'findings', 'evidence']); // properties is optional in JsonSchema (jsonSchema.ts:10)
});

Deno.test('review_task says that blocked waits on a person before the worker resumes', () => {
  const review = leadTools.find((t) => t.name === 'review_task')!;
  assert.match(review.description, /blocked means a person must decide/);
  assert.match(review.description, /worker resumes only after their answer/);
});
