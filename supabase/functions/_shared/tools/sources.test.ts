import assert from 'node:assert/strict';
import type { Db, DbResult } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { aiTools } from './ai.ts';
import { readTools } from './read.ts';
import { sourceCheckView, sourceTools } from './sources.ts';

type Row = Record<string, unknown>;
const tool = (name: string, tools = sourceTools) => tools.find((t) => t.name === name) as ToolDef;

function ctxWith(rpc: (fn: string, args: Row) => DbResult<unknown>, rows: Row[] = []): ToolContext {
  const db: Db = {
    download: () => Promise.resolve({ data: null, error: null }),
    rpc: <T>(fn: string, args: Row) => Promise.resolve(rpc(fn, args)) as Promise<DbResult<T>>,
    select: <T>() => Promise.resolve({ data: rows as T[], error: null }),
  };
  return { db, principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w1', clientId: null },
    signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: () => Promise.resolve(), progress: () => {} };
}

const page = (title: string, html: string) => ({ id: 'x', title, blocks: [{ id: 'b1', type: 'paragraph', html }, { id: 'b2', type: 'paragraph', html: 'Other' }] });

Deno.test('sourceCheckView turns pages into text and drops the page JSON', () => {
  const view = sourceCheckView({ task_id: 't', page: { id: 'd', title: 'Proposal', data: page('Proposal', 'We charge 10') },
    sources: [{ id: 's1', title: 'Pricing', data: page('Pricing', 'Price is 12'), block_id: 'b1', fingerprint: 'f', revision: 3 }, { id: 's2', title: 'Gone', data: null, fingerprint: 'deleted', revision: 4 }] }, '');
  assert.match(String((view.page as Row).text), /We charge 10/);
  const sources = view.sources as Row[];
  assert.equal(sources[0].text, 'Price is 12');
  assert.equal(sources[1].deleted, true);
  assert.equal(JSON.stringify(view).includes('blocks'), false);
});

Deno.test('tools pass their arguments to the RPC', async () => {
  const calls: [string, Row][] = [];
  const ctx = ctxWith((fn, args) => { calls.push([fn, args]); return { data: {}, error: null }; });
  await tool('declare_sources').handler({ run_id: 'r', page_id: 'p', sources: [{ url: 'https://a.b' }] }, ctx);
  await tool('report_source_check').handler({ run_id: 'r', verdict: 'current', checked: [{ id: 's', fingerprint: 'f', revision: 1 }] }, ctx);
  assert.deepEqual(calls[0], ['declare_sources', { p_page_id: 'p', p_sources: [{ url: 'https://a.b' }], p_run_id: 'r' }]);
  assert.equal(calls[1][0], 'report_source_check');
  assert.deepEqual(calls[1][1].p_items, []);
});

Deno.test('get_ai_request reads a check through its RPC, without touching a page', async () => {
  const fns: string[] = [];
  const ctx = ctxWith((fn) => { fns.push(fn); return { data: { task_id: 't1', page: { id: 'd', title: 'P', data: page('P', 'x') }, sources: [] }, error: null }; },
    [{ id: 't1', request_kind: 'source_check', request: { page_id: 'd' } }]);
  const out = await tool('get_ai_request', aiTools).handler({ task_id: 't1' }, ctx);
  assert.deepEqual(fns, ['source_check_context']);
  assert.equal(out.structured.kind, 'source_check');
});

Deno.test('read_page says when a source moved', async () => {
  const ctx = ctxWith((fn) => fn === 'get_page_bundle' ? { data: { page: page('P', 'x') }, error: null } : { data: { changed: 2, discrepancies: 1 }, error: null });
  const out = await tool('read_page', readTools).handler({ page_id: 'x' }, ctx);
  assert.equal(out.structured.changed_sources, 2);
  assert.equal(out.structured.open_discrepancies, 1);
  assert.match(out.text, /2 sources of this page changed/);
});

Deno.test('read_page keeps its answer when the state cannot be read', async () => {
  const ctx = ctxWith((fn) => fn === 'get_page_bundle' ? { data: { page: page('P', 'x') }, error: null } : { data: null, error: { code: 'PT500', message: 'boom' } });
  const out = await tool('read_page', readTools).handler({ page_id: 'x' }, ctx);
  assert.equal(out.structured.changed_sources, undefined);
  assert.doesNotMatch(out.text, /changed/);
});
