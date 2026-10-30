import assert from 'node:assert/strict';
import { type Db, type DbResult, ToolError } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { aiTools } from './ai.ts';
import { readTools } from './read.ts';
import { inlineMarkdownToSpans } from '../lib/agentInput.ts';
import { textPdf } from '../pdfFixtures.ts';

type Row = Record<string, unknown>;
const tool = (name: string) => aiTools.find((t) => t.name === name) as ToolDef;
const database = {
  id: 'database-data', properties: [
    { id: 'title', name: 'Task', type: 'text' }, { id: 'notes', name: 'Notes', type: 'text' },
    { id: 'p_ai', name: 'Summary', type: 'ai' },
  ],
  rows: [{ id: 'r1', pageId: 'row1', cells: { title: 'Acme', notes: 'Slow onboarding', p_ai: { text: 'Short', by: 'agent', id: 'u', at: 1 } } }], views: [],
};
const fill = { id: 't1', request_kind: 'fill', request: { page_id: 'db', property_id: 'p_ai', property_name: 'Summary', prompt: 'Summarize', row_ids: ['r1'], inputs: null, remaining: 0 } };

function harness(task: Row = fill, page: Row = { id: 'db', title: 'Feedback', blocks: [], database }) {
  const calls: { name: string; args: Row }[] = [];
  const db: Db = {
    download: async () => ({ data: null, error: null }),
    rpc: <T>(name: string, args: Row): Promise<DbResult<T>> => {
      calls.push({ name, args });
      return Promise.resolve({ data: (name === 'get_page_bundle' ? { page, pages: {} } : { task_state: 'done' }) as T, error: null });
    },
    select: <T>(spec: { table: string }): Promise<DbResult<T[]>> => Promise.resolve({ data: (spec.table === 'agent_tasks' ? [task] : []) as T[], error: null }),
  };
  const ctx: ToolContext = { db, principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w', clientId: null },
    signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: async () => {}, progress: () => {} };
  return { ctx, calls };
}

Deno.test('get_ai_request returns the rows with their input values', async () => {
  const h = harness();
  const out = await tool('get_ai_request').handler({ task_id: 't1' }, h.ctx);
  assert.deepEqual(out.structured.rows, [{ row_id: 'r1', rev: 0, title: 'Acme', inputs: { Task: 'Acme', Notes: 'Slow onboarding' } }]);
  const limited = harness({ ...fill, request: { ...fill.request, inputs: ['notes'] } });
  const subset = await tool('get_ai_request').handler({ task_id: 't1' }, limited.ctx);
  assert.deepEqual((subset.structured.rows as Row[])[0].inputs, { Notes: 'Slow onboarding' });
});
Deno.test('get_ai_request refuses a work task', async () => {
  await assert.rejects(() => tool('get_ai_request').handler({ task_id: 't1' }, harness({ ...fill, request_kind: null }).ctx),
    (error: unknown) => error instanceof ToolError && error.code === 'not_a_request');
});
Deno.test('fill_ai_cells passes the values to set_ai_cells', async () => {
  const h = harness(), values = [{ row_id: 'r1', text: 'Short', rev: 0 }];
  await tool('fill_ai_cells').handler({ run_id: 'run', values, idempotency_key: 'key' }, h.ctx);
  assert.deepEqual(h.calls, [{ name: 'set_ai_cells', args: { p_run_id: 'run', p_values: values, p_idempotency_key: 'key' } }]);
});
Deno.test('complete_ai_request passes summary and usage', async () => {
  const h = harness(), usage = { input_tokens: 1, output_tokens: 2, model: 'model', cost_usd: 0.1 };
  await tool('complete_ai_request').handler({ run_id: 'run', summary: 'Filled', usage }, h.ctx);
  assert.deepEqual(h.calls, [{ name: 'complete_ai_request', args: { p_run_id: 'run', p_summary: 'Filled', p_usage: usage } }]);
});
Deno.test('read tools show an ai cell as its text', async () => {
  const read = readTools.find((t) => t.name === 'query_database')!;
  const out = await read.handler({ database_id: 'db' }, harness().ctx);
  assert.equal(((out.structured.rows as Row[])[0].cells as Row).Summary, 'Short');
});
Deno.test('get_ai_request returns the block as inline Markdown', async () => {
  const h = harness({ id: 'rewrite', request_kind: 'rewrite', request: { page_id: 'page', block_id: 'b1', instruction: 'Shorter', selection: 'long' } },
    { id: 'page', blocks: [{ id: 'b1', type: 'paragraph', html: 'Our <b>long</b> intro', rev: 3 }] });
  const out = await tool('get_ai_request').handler({ task_id: 'rewrite' }, h.ctx);
  assert.deepEqual(out.structured.block, { id: 'b1', type: 'paragraph', text: 'Our **long** intro', rev: 3 });
});
Deno.test('apply_ai_rewrite turns Markdown into spans', async () => {
  const h = harness();
  await tool('apply_ai_rewrite').handler({ run_id: 'run', markdown: 'A **short** intro', rev: 3, idempotency_key: 'rewrite:t' }, h.ctx);
  assert.deepEqual(h.calls, [{ name: 'apply_ai_rewrite', args: { p_run_id: 'run', p_spans: inlineMarkdownToSpans('A **short** intro'),
    p_rev: 3, p_usage: undefined, p_idempotency_key: 'rewrite:t' } }]);
});

function fileHarness(opts: { blob?: Blob; name?: string; linked?: boolean; cached?: Row; size?: number; platform?: boolean } = {}) {
  const blob = opts.blob ?? new Blob(['hello'], { type: 'text/plain' });
  const h = harness(fill, { id: 'p', blocks: [{ id: 'b', type: 'file', fileId: 'f', fileName: opts.name ?? 'notes.md', fileSize: opts.size ?? blob.size }] });
  let downloads = 0;
  Object.assign(h.ctx.db, {
    select: <T>(spec: { table: string }): Promise<DbResult<T[]>> => Promise.resolve({ data: ({
      page_files: opts.linked === false ? [] : [{ page_id: 'p', file_id: 'f' }],
      files: [{ id: 'f', workspace_id: 'w' }], file_texts: opts.cached ? [opts.cached] : [],
      agents: [{ id: 'a', is_platform: opts.platform ?? false }], pages: [],
    }[spec.table] ?? []) as T[], error: null }),
    download: async () => { downloads++; return { data: blob, error: null }; },
    fileInfo: async () => ({ data: { size: opts.size ?? blob.size, mime: blob.type }, error: null }),
    signedUrl: async () => ({ data: 'https://files.test/signed', error: null }),
  });
  return { ...h, downloads: () => downloads };
}
const readFile = (h: ReturnType<typeof fileHarness>, range: Row = {}) => tool('read_file').handler({ page_id: 'p', file_id: 'f', ...range }, h.ctx);
Deno.test('read_file retries a previously cached transient failure under the same permissions', async () => {
  for (const platform of [false, true]) {
    const h = fileHarness({ name: 'scan.png', platform, cached: { status: 'failed', mime: 'image/png', pages: [], error: 'HTTP 503' } });
    const out = await readFile(h);
    assert.equal(out.structured.status, 'not_extracted');
    assert.equal(typeof out.structured.download_url, platform ? 'string' : 'undefined');
  }
});
Deno.test('read_file returns the saved text', async () => {
  const out = await readFile(fileHarness({ cached: { status: 'ready', mime: 'application/pdf', total_pages: 3, pages: [1, 2, 3].map((page) => ({ page, text: String(page) })) } }), { from_page: 2 });
  assert.deepEqual(out.structured.pages, [{ page: 2, text: '2' }, { page: 3, text: '3' }]);
  const withoutCount = await readFile(fileHarness({ cached: { status: 'partial', mime: null, total_pages: null, pages: [{ page: 3, text: 'Last page' }] } }));
  assert.equal(withoutCount.structured.total_pages, 3);
  assert.equal(withoutCount.structured.mime, 'application/octet-stream');
});
Deno.test('read_file reads a text file from storage', async () => {
  const h = fileHarness({ blob: new Blob(['a,b\n1,2']), name: 'data.csv' });
  const out = await readFile(h);
  assert.equal(out.structured.status, 'ready');
  assert.deepEqual(out.structured.pages, [{ page: 1, text: 'a,b\n1,2' }]);
  assert.equal(h.calls.some((c) => c.name === 'save_file_text'), false);
});
Deno.test('read_file refuses a file that is not on the page', async () => {
  await assert.rejects(() => readFile(fileHarness({ linked: false })), (e: unknown) => e instanceof ToolError && e.code === 'not_found');
});
Deno.test('read_file says not_extracted for an image without text', async () => {
  for (const platform of [false, true]) {
    const out = await readFile(fileHarness({ name: 'image.png', blob: new Blob(['image'], { type: 'image/png' }), platform }));
    assert.equal(out.structured.status, 'not_extracted');
    assert.equal(typeof out.structured.download_url === 'string', platform, 'only the platform agent receives a signed URL');
  }
});
Deno.test('read_file reads a PDF\'s text layer', async () => {
  const pdf = new Blob([new Uint8Array(textPdf(['BT (One) Tj ET', 'BT (Two) Tj ET']))], { type: 'application/pdf' });
  const out = await readFile(fileHarness({ name: 'doc.pdf', blob: pdf }));
  assert.equal(out.structured.status, 'ready');
  assert.deepEqual(out.structured.pages, [{ page: 1, text: 'One' }, { page: 2, text: 'Two' }]);
});
Deno.test('a scanned PDF says not_extracted', async () => {
  const out = await readFile(fileHarness({ name: 'scan.pdf', blob: new Blob([new Uint8Array(textPdf(['q /Image Do Q']))]) }));
  assert.equal(out.structured.status, 'not_extracted');
});
Deno.test('a PDF over 5 MB says not_extracted without downloading it', async () => {
  const h = fileHarness({ name: 'large.pdf', size: 6 * 1024 * 1024 });
  assert.equal((await readFile(h)).structured.status, 'not_extracted'); assert.equal(h.downloads(), 0);
});
Deno.test('an encrypted PDF says unsupported', async () => {
  const out = await readFile(fileHarness({ name: 'locked.pdf', blob: new Blob([new Uint8Array(textPdf([''], {}, '/Encrypt 40 0 R'))]) }));
  assert.equal(out.structured.status, 'unsupported'); assert.equal(out.structured.reason, 'the PDF is encrypted');
});
Deno.test('read_file says unsupported for a zip', async () => {
  assert.equal((await readFile(fileHarness({ name: 'data.zip', blob: new Blob(['zip'], { type: 'application/zip' }) }))).structured.status, 'unsupported');
});
Deno.test('a reply never passes 50000 characters', async () => {
  const out = await readFile(fileHarness({ blob: new Blob(['x'.repeat(60000)]) }));
  assert.equal((out.structured.pages as { text: string }[])[0].text.length, 50000); assert.equal(out.structured.truncated, true);
});

Deno.test('query_database ignores AI requests when reading work task columns', async () => {
  const page = { id: 'db', database: { ...database, properties: [...database.properties,
    { id: 'status', name: 'Status', type: 'agentStatus' }, { id: 'worker', name: 'Worker', type: 'agentDelegate' }] } };
  const h = harness(fill, page);
  const rows = [{ row_page_id: 'row1', state: 'ready_for_review', delegate_agent_id: 'worker', request_kind: null },
    { row_page_id: 'row1', state: 'done', delegate_agent_id: 'platform', request_kind: 'rewrite' }];
  h.ctx.db.select = <T>(spec: import('../db.ts').SelectSpec) => Promise.resolve({ data: (spec.table === 'agent_tasks'
    ? rows.filter(r => (spec.filters ?? []).every(f => f.col !== 'request_kind' || r.request_kind === f.value)) : []) as T[], error: null });
  const out = await readTools.find(t => t.name === 'query_database')!.handler({ database_id: 'db' }, h.ctx);
  assert.deepEqual((out.structured.rows as { raw: Row }[])[0].raw.Status, 'ready_for_review');
  assert.deepEqual((out.structured.rows as { raw: Row }[])[0].raw.Worker, 'worker');
});

Deno.test('get_ai_request rejects oversized Markdown without dropping the end of a block', async () => {
  const html = 'a'.repeat(4900) + '<a href="https://example.com/' + 'p'.repeat(200) + '">link</a> KEEP THE END';
  const h = harness({ id: 'rewrite', request_kind: 'rewrite', request: { page_id: 'page', block_id: 'b1' } },
    { id: 'page', blocks: [{ id: 'b1', type: 'paragraph', html, rev: 1 }] });
  await assert.rejects(() => tool('get_ai_request').handler({ task_id: 'rewrite' }, h.ctx),
    (e: unknown) => e instanceof ToolError && e.code === 'block_too_long');
});
