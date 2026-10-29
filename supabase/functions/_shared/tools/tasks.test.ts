import assert from 'node:assert/strict';
import { type Db, ToolError } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { taskTools } from './tasks.ts';

const tool = (name: string) => taskTools.find((t) => t.name === name) as ToolDef;

function ctxWith(rpc: Db['rpc']): ToolContext {
  const db: Db = { rpc, select: () => Promise.resolve({ data: [], error: null }) };
  return {
    db,
    principal: { type: 'agent', userId: 'u-agent', agentId: 'agent-1', workspaceId: 'w1', clientId: null },
    signal: new AbortController().signal,
    appUrl: '',
    now: () => 0,
    sleep: () => Promise.resolve(),
    progress: () => {},
  };
}

Deno.test('claim_task does not promise to reopen done tasks', () => {
  assert.doesNotMatch(tool('claim_task').description, /reopens it with a new run/);
  assert.match(tool('claim_task').description, /only a person reopens it/);
});

Deno.test('claim_task surfaces task_unavailable as a ToolError the model can act on', async () => {
  const ctx = ctxWith(() => Promise.resolve({ data: null, error: { code: 'PT409', message: 'task_unavailable' } }));
  await assert.rejects(
    () => tool('claim_task').handler({ task_id: 't1', harness: 'codex' }, ctx),
    (err: unknown) => err instanceof ToolError && err.code === 'task_unavailable'
      && err.message === 'The task cannot be claimed in its current state.',
  );
});
