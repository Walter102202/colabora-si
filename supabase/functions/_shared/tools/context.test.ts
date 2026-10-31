import assert from 'node:assert/strict';
import type { Db, DbResult } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { briefTerms, contextLine, contextPackage, contextTools, relatedPages } from './context.ts';
import { taskTools } from './tasks.ts';

type Row = Record<string, unknown>;
const tool = (name: string, tools = contextTools) => tools.find((t) => t.name === name) as ToolDef;

function ctxWith(rpc: (fn: string, args: Row) => DbResult<unknown>, select: (table: string) => Row[] = () => []): ToolContext {
  const db: Db = {
    download: () => Promise.resolve({ data: null, error: null }),
    rpc: <T>(fn: string, args: Row) => Promise.resolve(rpc(fn, args)) as Promise<DbResult<T>>,
    select: <T>(spec: { table: string }) => Promise.resolve({ data: select(spec.table) as T[], error: null }),
  };
  return { db, principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w1', clientId: null },
    signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: () => Promise.resolve(), progress: () => {} };
}

Deno.test('briefTerms keeps the words that say something, folded, most repeated first', () => {
  assert.deepEqual(briefTerms('Write the client report. The client wants fechas de facturación.'), ['client', 'report', 'wants', 'fechas', 'facturacion']);
  assert.deepEqual(briefTerms('the and of task'), []);
});

Deno.test('relatedPages searches as the caller and explains each page', async () => {
  const calls: Row[] = [];
  const ctx = ctxWith((_fn, args) => {
    calls.push(args);
    return { data: [
      { kind: 'row', pageId: 'p1', title: 'Client report template', snippet: '' },
      { kind: 'page', pageId: 'p2', title: 'Notes', snippet: 'a client said hi' },
      { kind: 'page', pageId: 'p3', title: 'Notes', snippet: 'client invoices and report dates' },
      { kind: 'page', pageId: 'row', title: 'Client report', snippet: '' },
      { kind: 'page', pageId: 'src', title: 'Client report', snippet: '' },
      { kind: 'task', pageId: 'p4', title: 'Client report', snippet: '' },
      { kind: 'page', pageId: 'p1', title: 'Client report template', snippet: 'again' },
    ], error: null };
  });
  const out = await relatedPages(ctx.db, 'w1', 'row', { objective: 'Write the client report', sources: [{ kind: 'page', ref: 'src' }] });
  assert.equal(calls[0].p_query, 'client or report');
  assert.deepEqual(out.map((r) => r.page_id), ['p1', 'p3']);
  assert.equal(out[0].why, 'Shares with your brief: client, report');
});

Deno.test('a failing package never fails the caller', async () => {
  const ctx = ctxWith(() => ({ data: null, error: { code: 'PT500', message: 'boom' } }));
  assert.equal(await contextPackage(ctx, 'r1', 'row', {}), null);
  assert.match(contextLine(null), /get_context_package/);
});

Deno.test('a failing search keeps the rest of the package', async () => {
  const ctx = ctxWith((fn) => fn === 'task_context' ? { data: { lessons: [{ id: 'l1' }] }, error: null } : { data: null, error: { code: 'PT500', message: 'boom' } });
  const pkg = await contextPackage(ctx, 'r1', 'row', { objective: 'Write the client report' });
  assert.deepEqual(pkg, { lessons: [{ id: 'l1' }], related_pages: [] });
});

Deno.test('claim_task returns the package after the claim', async () => {
  const fns: string[] = [];
  const ctx = ctxWith((fn) => {
    fns.push(fn);
    if (fn === 'claim_task') return { data: { task_id: 't1', run_id: 'r1', row_page_id: 'row', brief: { objective: 'Write' } }, error: null };
    if (fn === 'task_context') return { data: { lessons: [{ id: 'l1' }], decisions: [], sources: [] }, error: null };
    return { data: [], error: null };
  });
  const out = await tool('claim_task', taskTools).handler({ task_id: 't1', harness: 'codex' }, ctx);
  assert.deepEqual(fns.slice(0, 2), ['claim_task', 'task_context']);
  assert.deepEqual((out.structured.context_package as Row).lessons, [{ id: 'l1' }]);
  assert.match(out.text, /1 lesson\(s\).*cite_lesson/);
});

Deno.test('claim_task survives a broken package', async () => {
  const ctx = ctxWith((fn) => fn === 'claim_task'
    ? { data: { task_id: 't1', run_id: 'r1', row_page_id: 'row', brief: {} }, error: null }
    : { data: null, error: { code: 'PT500', message: 'boom' } });
  const out = await tool('claim_task', taskTools).handler({ task_id: 't1', harness: 'codex' }, ctx);
  assert.equal(out.structured.run_id, 'r1');
  assert.equal(out.structured.context_package, null);
});

Deno.test('a request gets no package: it is the platform agent working on its own input', async () => {
  const fns: string[] = [];
  const ctx = ctxWith((fn) => {
    fns.push(fn);
    return { data: { task_id: 't1', run_id: 'r1', row_page_id: 'row', brief: { policies: { ai_request: 'lesson' } } }, error: null };
  });
  await tool('claim_task', taskTools).handler({ task_id: 't1', harness: 'platform' }, ctx);
  assert.deepEqual(fns, ['claim_task']);
});

Deno.test('cite_lesson passes its arguments to the RPC', async () => {
  const calls: [string, Row][] = [];
  const ctx = ctxWith((fn, args) => { calls.push([fn, args]); return { data: {}, error: null }; });
  await tool('cite_lesson').handler({ run_id: 'r', lesson_id: 'l', note: 'n' }, ctx);
  assert.deepEqual(calls[0], ['cite_lesson', { p_run_id: 'r', p_lesson_id: 'l', p_note: 'n' }]);
});
