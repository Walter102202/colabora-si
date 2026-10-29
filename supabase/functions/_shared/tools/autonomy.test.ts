import assert from 'node:assert/strict';
import { buildServer } from '../../mcp/server.ts';
import type { Db, DbResult } from '../db.ts';
import type { ToolContext } from '../mcp.ts';
import { leadTools } from './lead.ts';

// Autonomy is about actions with effects. A tool that only reads never asks a person for anything:
// none may call the RPCs that open, answer or consume an approval, or change an autonomy level.
const ASKING_RPCS = new Set(['request_input', 'request_approval', 'begin_external_op', 'decide_approval', 'set_workspace_autonomy', 'set_task_autonomy']);
const PRINCIPALS: ToolContext['principal'][] = [
  { type: 'agent', userId: 'u-agent', agentId: 'agent-1', workspaceId: 'w1', clientId: null },
  { type: 'human', userId: 'u-owner', agentId: null, workspaceId: 'w1', clientId: null },
];

// One plausible row for every table (a delivered task with an active run), so each tool gets past its first read and
// reaches the RPCs it calls; an empty table would stop most of them at not_found.
const ROW: Record<string, unknown> = {
  id: 'x', task_id: 'x', workspace_id: 'w1', row_page_id: 'page-1', title: 'Task', state: 'ready_for_review', review_state: 'pending',
  brief_version: 1, active_run_id: 'run-1', delegate_agent_id: 'agent-1', owner_user_id: 'u-owner', seq: 1, type: 'prompt', body: {},
  status: 'decided', kind: 'elicitation', blocking: false, created_at: '2026-10-29T10:00:00+00:00', updated_at: '2026-10-29T10:00:00+00:00',
  ended_at: '2026-10-29T09:00:00+00:00', decided_at: '2026-10-29T09:30:00+00:00',
};

function dummy(schema: { type?: unknown } | undefined): unknown {
  switch (schema?.type) {
    case 'integer':
    case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    default: return 'x';
  }
}

Deno.test('read-only tools never call an RPC that asks a person', async () => {
  const readOnly = buildServer().tools.filter((t) => t.annotations?.readOnlyHint === true);
  assert.ok(readOnly.length >= 8, `expected the read tools, got ${readOnly.length}`);
  const reached = new Map<string, Set<string>>();
  const failed = new Set<string>();
  for (const principal of PRINCIPALS) {
    for (const t of readOnly) {
      // Required arguments only, then also the run and the cursor that make a wait register itself.
      for (const extra of [{}, { run_id: 'run-1', after_seq: 0 }]) {
        const called: string[] = [];
        const db: Db = {
          rpc: <T>(fn: string): Promise<DbResult<T>> => {
            called.push(fn);
            return Promise.resolve({ data: {} as T, error: null });
          },
          select: <T>(): Promise<DbResult<T[]>> => Promise.resolve({ data: [{ ...ROW }] as T[], error: null }),
        };
        let clock = 0;
        const ctx: ToolContext = {
          db, principal, signal: new AbortController().signal, appUrl: 'https://app.example',
          now: () => (clock += 5_000), sleep: () => Promise.resolve(), progress: () => {},
        };
        const schema = t.inputSchema as { properties?: Record<string, { type?: unknown }>; required?: string[] };
        const args: Record<string, unknown> = {};
        for (const key of schema.required ?? []) args[key] = dummy(schema.properties?.[key]);
        for (const [key, value] of Object.entries(extra)) if (schema.properties && key in schema.properties) args[key] = value;
        if (schema.properties && 'timeout_s' in schema.properties) args.timeout_s = 0;
        await t.handler(args, ctx).catch(() => failed.add(`${t.name} (${principal.type})`));
        assert.deepEqual(called.filter((fn) => ASKING_RPCS.has(fn)), [], `${t.name} (${principal.type}) must not ask`);
        reached.set(t.name, new Set([...reached.get(t.name) ?? [], ...called]));
      }
    }
  }
  // The check above proves something only if the tools get that far with this fake.
  assert.ok(!failed.has('get_task (agent)') && !failed.has('get_task (human)'), `get_task runs to the end (failed: ${[...failed].join(', ')})`);
  assert.ok(reached.get('get_task')?.has('task_autonomy'), 'get_task reads the autonomy');
  assert.ok(reached.get('get_task')?.has('task_diff'), 'and the diff of a delivered task');
  assert.ok(reached.get('wait_for_task')?.has('touch_run_wait'), 'wait_for_task registers the wait');
});

Deno.test('create_subtask tells the Lead that a subtask never gets more than its parent', () => {
  const create = leadTools.find((t) => t.name === 'create_subtask');
  assert.ok(create);
  assert.match(JSON.stringify(create.inputSchema), /never gets more than its parent/);
});
