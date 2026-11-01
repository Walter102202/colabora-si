import assert from 'node:assert/strict';
import type { Db } from '../db.ts';
import type { ToolContext } from '../mcp.ts';
import { readTools } from './read.ts';

for (const name of ['fetch', 'read_page']) {
  Deno.test(`${name}: only a successful agent read signals, without changing its result`, async () => {
    const tool = readTools.find(t => t.name === name)!;
    const args = name === 'fetch' ? { id: 'starter' } : { page_id: 'starter' };
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let mode = 'ok';
    const db: Db = {
      rpc: (fn, params) => {
        calls.push({ name: fn, args: params });
        if (fn === 'record_agent_read') {
          if (mode === 'throw') throw new Error('sync failure');
          if (mode === 'reject') return Promise.reject(new Error('async failure'));
          return Promise.resolve({ data: null, error: mode === 'error' ? { message: 'db failure' } : null });
        }
        const data = fn === 'get_page_bundle' && mode !== 'missing'
          ? { page: { id: 'starter', title: 'Getting started', blocks: [{ id: 'b', type: 'paragraph', html: 'Hello', indent: 0, rev: 1 }] } } : null;
        return Promise.resolve({ data: data as never, error: null });
      },
      select: async () => ({ data: [], error: null }), download: async () => ({ data: null, error: null }),
    };
    const ctx: ToolContext = { db, principal: { type: 'human', userId: 'u', agentId: null, workspaceId: 'w', clientId: null },
      signal: new AbortController().signal, appUrl: 'https://local.test', now: () => 0, sleep: async () => {}, progress: () => {} };
    const expected = await tool.handler(args, ctx);
    assert.equal(calls.filter(c => c.name === 'record_agent_read').length, 0);
    ctx.principal = { ...ctx.principal, type: 'agent', agentId: 'a' };
    for (mode of ['ok', 'throw', 'reject', 'error']) {
      calls.length = 0;
      assert.deepEqual(await tool.handler(args, ctx), expected, mode);
      assert.deepEqual(calls.filter(c => c.name === 'record_agent_read'), [{ name: 'record_agent_read', args: { p_page_id: 'starter' } }]);
    }
    mode = 'missing'; calls.length = 0;
    await assert.rejects(() => tool.handler(args, ctx));
    assert.equal(calls.filter(c => c.name === 'record_agent_read').length, 0);
  });
}
