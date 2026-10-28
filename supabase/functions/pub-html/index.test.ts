import assert from 'node:assert/strict';
import type { Db, DbResult } from '../_shared/db.ts';
import type { Block, Page } from '../_shared/lib/types.ts';
import { handlePubHtml, parseRoute, type PubHtmlDeps, wantsMarkdown } from './handler.ts';

function block(id: string, type: Block['type'], html = '', extra: Partial<Block> = {}): Block {
  return { id, type, html, indent: 0, ...extra };
}

function page(id: string, title: string, blocks: Block[], extra: Partial<Page> = {}): Page {
  return {
    id, title, icon: null, cover: null, parentId: null, blocks, isFavorite: false, isDeleted: false,
    fullWidth: false, smallText: false, createdAt: 0, updatedAt: 0, ...extra,
  };
}

const UPDATED = Date.UTC(2026, 9, 28, 12, 0, 0);
const PUBLIC = page('launch-plan', 'Launch <plan>', [
  block('h', 'heading2', 'Findings'),
  block('p', 'paragraph', 'Ship <strong>fast</strong> &amp; safe <script>alert(1)</script>'),
  block('t', 'todo', 'Write the post', { checked: true }),
  block('l', 'page', '', { pageId: 'notes' }),
], { icon: '🚀', cover: 'https://img.test/cover.png', updatedAt: UPDATED });
const BUNDLE = { page: PUBLIC, updatedAt: UPDATED, pages: { notes: page('notes', 'Notes', []) }, syncedBlocks: {}, truncated: false };
const DELETED = { ...BUNDLE, page: { ...PUBLIC, id: 'gone', isDeleted: true } };

type RpcOutcome = { data: unknown; error: { message: string } | null };

function setup(outcome: (id: string) => RpcOutcome = (id) => ({ data: id === 'launch-plan' ? BUNDLE : id === 'gone' ? DELETED : null, error: null }), appUrl = 'https://app.test') {
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  const db: Db = {
    rpc: (fn, params) => {
      calls.push({ fn, params });
      return Promise.resolve(outcome(String(params.p_page_id))) as Promise<DbResult<never>>;
    },
    select: () => Promise.reject(new Error('unexpected select')),
  };
  const deps: PubHtmlDeps = { db, appUrl };
  return { deps, calls };
}

const request = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`https://project.test/functions/v1/pub-html${path}`, { method, headers });

Deno.test('HTML of a public page: title, description, Open Graph, canonical, alternate and escaped content', async () => {
  const { deps, calls } = setup();
  const res = await handlePubHtml(request('/launch-plan'), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=300');
  assert.equal(res.headers.get('Vary'), 'Accept');
  assert.equal(res.headers.get('Link'), '<https://app.test/pub/launch-plan.md>; rel="alternate"; type="text/markdown"');
  assert.ok(res.headers.get('Content-Security-Policy')?.startsWith("default-src 'none'"));
  const body = await res.text();
  assert.ok(body.startsWith('<!doctype html>\n<html lang="en">'));
  assert.ok(body.includes('<title>Launch &lt;plan&gt; · colabora.si</title>'));
  assert.ok(body.includes('<meta name="description" content="Findings Ship fast &amp; safe alert(1) Write the post">'));
  assert.ok(body.includes('<link rel="canonical" href="https://app.test/pub/launch-plan">'));
  assert.ok(body.includes('<link rel="alternate" type="text/markdown" href="https://app.test/pub/launch-plan.md">'));
  assert.ok(body.includes('<meta property="og:title" content="Launch &lt;plan&gt;">'));
  assert.ok(body.includes('<meta property="og:url" content="https://app.test/pub/launch-plan">'));
  assert.ok(body.includes('<meta property="og:type" content="article">'));
  assert.ok(body.includes('<meta property="og:image" content="https://img.test/cover.png">'));
  assert.ok(body.includes('<meta property="og:site_name" content="colabora.si">'));
  assert.ok(body.includes('<meta property="article:modified_time" content="2026-10-28T12:00:00.000Z">'));
  assert.ok(body.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(body.includes('<h1>Launch &lt;plan&gt;</h1>'));
  assert.ok(body.includes('<h3>Findings</h3>'));
  assert.ok(body.includes('<p>Ship <strong>fast</strong> &amp; safe alert(1)</p>'));
  assert.ok(body.includes('<li class="done"><input type="checkbox" disabled checked> Write the post</li>'));
  assert.ok(body.includes('<a href="https://app.test/pub/notes">Notes</a>'));
  assert.ok(body.includes('<footer><a href="https://app.test/pub/launch-plan">Open in colabora.si</a></footer>'));
  assert.ok(!/<script/i.test(body));
  assert.deepEqual(calls, [{ fn: 'get_page_bundle', params: { p_page_id: 'launch-plan' } }]);
});

Deno.test('the .md suffix returns Markdown with the title as H1', async () => {
  const { deps, calls } = setup();
  const res = await handlePubHtml(request('/launch-plan.md'), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=300');
  assert.equal(res.headers.get('Link'), '<https://app.test/pub/launch-plan>; rel="alternate"; type="text/html"');
  const body = await res.text();
  assert.ok(body.startsWith('# Launch <plan>\n\n## Findings'));
  assert.ok(body.includes('Ship **fast** & safe alert(1)'));
  assert.ok(body.includes('- [x] Write the post'));
  assert.ok(body.includes('[Notes](https://app.test/pub/notes)'));
  assert.ok(body.endsWith('\n'));
  assert.deepEqual(calls[0].params, { p_page_id: 'launch-plan' });
});

Deno.test('Accept: text/markdown selects Markdown; browsers keep HTML', async () => {
  const { deps } = setup();
  const md = await handlePubHtml(request('/launch-plan', { Accept: 'text/markdown' }), deps);
  assert.equal(md.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.ok((await md.text()).startsWith('# Launch <plan>'));
  const html = await handlePubHtml(request('/launch-plan', { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }), deps);
  assert.equal(html.headers.get('Content-Type'), 'text/html; charset=utf-8');
  await html.body?.cancel();
  assert.equal(wantsMarkdown('text/markdown;q=0.9, text/html;q=0.5'), true);
  assert.equal(wantsMarkdown('text/html, text/markdown;q=0.5'), false);
  assert.equal(wantsMarkdown('*/*'), false);
  assert.equal(wantsMarkdown(null), false);
});

Deno.test('a page that is not public or is deleted is 404 with a tiny body', async () => {
  const { deps } = setup();
  for (const path of ['/private', '/gone']) {
    const res = await handlePubHtml(request(path), deps);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.text();
    assert.ok(body.length < 300);
    assert.ok(body.includes('<h1>Not found</h1>'));
  }
  const md = await handlePubHtml(request('/private.md'), deps);
  assert.equal(md.status, 404);
  assert.equal(md.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.equal(await md.text(), "# Not found\n\nThis page doesn't exist or is no longer public.\n");
});

Deno.test('a malformed or missing id is 400 without touching the database', async () => {
  const { deps, calls } = setup();
  for (const path of ['/bad%20id', '/', '/a.b.md', '/' + 'x'.repeat(65)]) {
    const res = await handlePubHtml(request(path), deps);
    assert.equal(res.status, 400, path);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    await res.body?.cancel();
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(parseRoute('/functions/v1/pub-html/abc.md'), { base: '/functions/v1/pub-html', id: 'abc', suffix: 'md' });
  assert.deepEqual(parseRoute('/pub-html/abc/'), { base: '/pub-html', id: 'abc', suffix: null });
  assert.equal(parseRoute('/pub-html'), null);
});

Deno.test('HEAD returns the headers of the GET without a body', async () => {
  const { deps } = setup();
  const res = await handlePubHtml(request('/launch-plan', {}, 'HEAD'), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=300');
  assert.ok(Number(res.headers.get('Content-Length')) > 1000);
  assert.equal(await res.text(), '');
  const missing = await handlePubHtml(request('/private', {}, 'HEAD'), deps);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), '');
});

Deno.test('OPTIONS answers the CORS preflight for GET and other methods are 405', async () => {
  const { deps, calls } = setup();
  const options = await handlePubHtml(request('/launch-plan', {}, 'OPTIONS'), deps);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
  const post = await handlePubHtml(request('/launch-plan', {}, 'POST'), deps);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD, OPTIONS');
  await post.body?.cancel();
  assert.equal(calls.length, 0);
});

Deno.test('a database error is 503 and never cached', async () => {
  const { deps } = setup(() => ({ data: null, error: { message: 'connection refused' } }));
  const res = await handlePubHtml(request('/launch-plan'), deps);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Retry-After'), '30');
  await res.body?.cancel();
});

Deno.test('without APP_URL every link points at the function itself', async () => {
  const { deps } = setup(undefined, '');
  const res = await handlePubHtml(request('/launch-plan'), deps);
  const body = await res.text();
  assert.ok(body.includes('<link rel="canonical" href="https://project.test/functions/v1/pub-html/launch-plan">'));
  assert.ok(body.includes('href="https://project.test/functions/v1/pub-html/launch-plan.md"'));
  assert.ok(body.includes('<a href="https://project.test/functions/v1/pub-html/notes">Notes</a>'));
  const md = await handlePubHtml(request('/launch-plan.md'), deps);
  assert.ok((await md.text()).includes('[Notes](https://project.test/functions/v1/pub-html/notes)'));
});
