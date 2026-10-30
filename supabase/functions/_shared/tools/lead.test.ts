import assert from 'node:assert/strict';
import { briefBlocks, BRIEF_KEYS, leadTools } from './lead.ts';
import { type Db, type DbResult, type SelectSpec, ToolError } from '../db.ts';
import type { ToolContext } from '../mcp.ts';

type Row = Record<string, unknown>;
const tool = (name: string) => {
  const found = leadTools.find((t) => t.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
};
function context(rpc: (fn: string, args: Row) => DbResult<unknown>, select?: (spec: SelectSpec) => Row[]): ToolContext {
  const db: Db = {
    rpc: <T>(fn: string, args: Row) => Promise.resolve(rpc(fn, args) as DbResult<T>),
    select: <T>(spec: SelectSpec) => Promise.resolve({ data: (select?.(spec) ?? [{ db_page_id: 'db1' }]) as T[], error: null }),
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

const planBrief = { objective: 'Work', done_when: [{ id: 'c1', text: 'Delivered', check: 'lead' }] };

Deno.test('environment tools reserve and release through RPCs, preserving conflict details', async () => {
  const items = [{ kind: 'ports', value: '60990-60999' }];
  const calls: Row[] = [];
  const ctx = context((fn, args) => { calls.push({ fn, args }); return { data: fn === 'reserve_environment' ? items : { released: 1 }, error: null }; });
  assert.deepEqual((await tool('reserve_environment').handler({ task_id: 't1', items }, ctx)).structured, { environment: items });
  assert.deepEqual((await tool('release_environment').handler({ task_id: 't1' }, ctx)).structured, { released: 1 });
  assert.deepEqual(calls, [
    { fn: 'reserve_environment', args: { p_task_id: 't1', p_items: items } },
    { fn: 'release_environment', args: { p_task_id: 't1' } },
  ]);
  const detail = { ...items[0], task_id: 'other', status: 'held' };
  const conflict = context(() => ({ data: null, error: { code: 'PT409', message: 'resource_taken', details: JSON.stringify(detail) } }));
  await assert.rejects(() => tool('reserve_environment').handler({ task_id: 't1', items }, conflict), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, 'resource_taken'); assert.deepEqual(error.detail, detail); return true;
  });
});

Deno.test('list_environments reads only unreleased resources through the caller database', async () => {
  const rows = [{ task_id: 't1', kind: 'stack', value: 'p11', status: 'releasing' }];
  const ctx = context(() => { assert.fail('no RPC'); }, (spec) => {
    assert.equal(spec.table, 'agent_resources');
    assert.deepEqual(spec.filters, [{ col: 'status', op: 'neq', value: 'released' }]);
    assert.equal(spec.columns, 'kind,value,status,task_id');
    return rows;
  });
  assert.deepEqual((await tool('list_environments').handler({}, ctx)).structured, { environments: rows });
});
const planArgs = { parent_task_id: 'parent', idempotency_key: 'plan-key' };
function planContext(failKey?: string) {
  const calls: { fn: string; args: Row }[] = [];
  const ctx = context((fn, args) => {
    calls.push({ fn, args });
    if (fn === 'add_row') return { data: { row_id: `row:${args.p_idempotency_key}`, page_id: `page:${args.p_idempotency_key}` }, error: null };
    if (args.p_idempotency_key === failKey) return { data: null, error: { code: 'PT403', message: 'forbidden' } };
    return { data: { task_id: `task:${args.p_idempotency_key}`, context_id: 'context' }, error: null };
  });
  return { ctx, calls };
}

Deno.test('import_plan sorts dependencies, resolves their ids and retries with identical keys', async () => {
  const { ctx, calls } = planContext();
  const args = { ...planArgs, subtasks: [
    { key: 'second', depends_on: ['first'], brief: planBrief, delegate_agent_id: 'worker' },
    { key: 'first', brief: planBrief },
    { key: '__proto__', depends_on: ['second'], brief: planBrief },
  ] };
  const first = await tool('import_plan').handler(args, ctx);
  const created = Object.fromEntries(['first', 'second', '__proto__'].map((key) => [key, `task:plan-key:${key}`]));
  assert.deepEqual(first.structured, { created });
  const writes = calls.filter((c) => c.fn === 'create_subtask');
  assert.deepEqual(writes.map((c) => c.args.p_idempotency_key), ['plan-key:first', 'plan-key:second', 'plan-key:__proto__']);
  assert.deepEqual(writes[1].args.p_depends_on_task_ids, ['task:plan-key:first']);
  assert.equal(writes[1].args.p_delegate_agent_id, 'worker');
  const before = structuredClone(calls);
  assert.deepEqual((await tool('import_plan').handler(args, ctx)).structured, first.structured);
  assert.deepEqual(calls.slice(before.length), before);
});

Deno.test('import_plan rejects duplicate, missing, cyclic and invalid briefs before any write', async () => {
  for (const subtasks of [
    [{ key: 'a', brief: planBrief }, { key: 'a', brief: planBrief }],
    [{ key: 'a', brief: planBrief, depends_on: ['missing'] }],
    [{ key: 'a', brief: planBrief, depends_on: ['b'] }, { key: 'b', brief: planBrief, depends_on: ['a'] }],
    [{ key: 'a', brief: planBrief }, { key: 'b', brief: {} }],
  ]) {
    const { ctx, calls } = planContext();
    await assert.rejects(() => tool('import_plan').handler({ ...planArgs, subtasks }, ctx),
      (error: unknown) => error instanceof ToolError && error.code === 'invalid_input');
    assert.deepEqual(calls, []);
  }
});

Deno.test('import_plan includes completed subtasks in a partial failure', async () => {
  const { ctx } = planContext('plan-key:b');
  await assert.rejects(() => tool('import_plan').handler({ ...planArgs, subtasks: [
    { key: 'a', brief: planBrief }, { key: 'b', brief: planBrief },
  ] }, ctx), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, 'forbidden');
    assert.deepEqual((error.detail as Row).created, { a: 'task:plan-key:a' });
    return true;
  });
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
