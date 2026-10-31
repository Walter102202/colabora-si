import assert from 'node:assert/strict';
import type { Db } from '../db.ts';
import type { ToolContext } from '../mcp.ts';
import { handleMcp } from '../mcp.ts';
import { AuthError } from '../jwt.ts';
import { buildWorkspaceServer } from '../../workspace-mcp/server.ts';
import { buildServer } from '../../mcp/server.ts';
import { readTools } from './read.ts';
import { writeTools } from './write.ts';

Deno.test('workspace keeps shared definitions and limits discovery; legacy tools stay unchanged', () => {
  const server = buildWorkspaceServer();
  assert.equal(server.tools.length, 23);
  assert.ok(server.instructions.length <= 800);
  for (const tool of [...readTools, ...writeTools]) assert.equal(server.tools.find(t => t.name === tool.name), tool);
  assert.ok(!buildServer().tools.some(t => t.name === 'create_database'));
});
Deno.test('workspace creates a database in one RPC, renders markdown and returns a usable URL', async () => {
  const calls: unknown[] = [];
  const db: Db = {
    rpc: (name, args) => { calls.push({ name, args }); return Promise.resolve({ data: { id: 'p', revision: 4 } as never, error: null }); },
    select: async () => ({ data: [], error: null }), download: async () => ({ data: null, error: null }),
  };
  const ctx: ToolContext = { db, principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w', clientId: null },
    signal: new AbortController().signal, appUrl: 'https://local.test', now: () => 0, sleep: async () => {}, progress: () => {} };
  const tool = buildWorkspaceServer().tools.find(t => t.name === 'create_database')!;
  const result = await tool.handler({ parent_id: 'parent', title: 'CRM', rows: [{ cells: { Name: { text: 'Acme' } }, markdown: '# Notes' }], idempotency_key: 'crm' }, ctx);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { name: string }).name, 'create_database');
  assert.equal(result.structured.url, 'https://local.test/p/p');
  assert.equal(result.structured.revision, 4);
  const args = (calls[0] as { args: { p_input: { rows: { blocks: { type: string }[]; markdown?: string }[] } } }).args;
  assert.equal(args.p_input.rows[0].blocks[0].type, 'heading1');
  assert.equal(args.p_input.rows[0].markdown, undefined);
});
Deno.test('workspace metadata and 401 use their own resource, not the global mcp URL', async () => {
  const deps = { env: { MCP_RESOURCE_URL: 'https://test/mcp', MCP_AUTH_SERVER_URL: 'https://test/auth' },
    verify: async () => { throw new AuthError(401, 'invalid_token', 'Missing token'); }, makeDb: () => ({} as Db) };
  const options = { resourceUrl: 'https://test/workspace-mcp' };
  const response = await handleMcp(new Request('https://internal/workspace-mcp', { method: 'POST' }), buildWorkspaceServer(), deps, options);
  assert.equal(response.status, 401);
  assert.ok(response.headers.get('WWW-Authenticate')?.includes('https://test/workspace-mcp/.well-known/'));
  const metadata = await handleMcp(new Request('https://internal/workspace-mcp/.well-known/oauth-protected-resource'), buildWorkspaceServer(), deps, options);
  assert.equal((await metadata.json()).resource, options.resourceUrl);
});
