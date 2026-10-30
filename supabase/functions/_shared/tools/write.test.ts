import assert from 'node:assert/strict';
import { type Db, type DbResult, definedParams } from '../db.ts';
import type { ToolContext } from '../mcp.ts';
import { writeTools } from './write.ts';

Deno.test('add_comment replies in a thread', async () => {
  for (const parentId of ['c1', undefined]) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const db: Db = {
    download: async () => ({ data: null, error: null }),
      rpc: <T>(name: string, args: Record<string, unknown>): Promise<DbResult<T>> => {
        calls.push({ name, args: definedParams(args) });
        const page = { id: 'p', blocks: [], comments: [
          { id: 'reply', body: 'Done', authorId: 'u', parentId, createdAt: 1 },
          { id: 'other-thread', body: 'Done', authorId: 'u', parentId: 'c2', createdAt: 2 },
        ] };
        return Promise.resolve({ data: (name === 'add_page_comment' ? 'ok' : { page, pages: {} }) as T, error: null });
      },
      select: async () => ({ data: [], error: null }),
    };
    const ctx: ToolContext = { db, principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w', clientId: null },
      signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: async () => {}, progress: () => {} };
    const result = await writeTools.find((t) => t.name === 'add_comment')!.handler({ page_id: 'p', body: 'Done', ...(parentId ? { parent_id: parentId } : {}) }, ctx);
    assert.deepEqual(calls[0], { name: 'add_page_comment', args: { p_page_id: 'p', p_body: 'Done', ...(parentId ? { p_parent_id: parentId } : {}) } });
    assert.equal(result.structured.comment_id, 'reply', 'the returned id belongs to the requested thread');
  }
});
