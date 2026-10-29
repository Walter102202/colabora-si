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
  for (const principal of PRINCIPALS) {
    for (const t of readOnly) {
      const called: string[] = [];
      const db: Db = {
        rpc: <T>(fn: string): Promise<DbResult<T>> => {
          called.push(fn);
          return Promise.resolve({ data: {} as T, error: null });
        },
        select: <T>(): Promise<DbResult<T[]>> => Promise.resolve({ data: [] as T[], error: null }),
      };
      let clock = 0;
      const ctx: ToolContext = {
        db, principal, signal: new AbortController().signal, appUrl: 'https://app.example',
        now: () => (clock += 5_000), sleep: () => Promise.resolve(), progress: () => {},
      };
      const schema = t.inputSchema as { properties?: Record<string, { type?: unknown }>; required?: string[] };
      const args: Record<string, unknown> = {};
      for (const key of schema.required ?? []) args[key] = dummy(schema.properties?.[key]);
      if (schema.properties && 'timeout_s' in schema.properties) args.timeout_s = 0;
      await t.handler(args, ctx).catch(() => undefined);
      assert.deepEqual(called.filter((fn) => ASKING_RPCS.has(fn)), [], `${t.name} (${principal.type}) must not ask`);
    }
  }
});

Deno.test('create_subtask tells the Lead that a subtask never gets more than its parent', () => {
  const create = leadTools.find((t) => t.name === 'create_subtask');
  assert.ok(create);
  assert.match(JSON.stringify(create.inputSchema), /never gets more than its parent/);
});
