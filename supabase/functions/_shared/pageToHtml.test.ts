import assert from 'node:assert/strict';
import type { Block, Page } from './lib/types.ts';
import { databaseToHtml, inlineHtml, nestByIndent, pageDescription, pageToHtml, renderPublicPage } from './pageToHtml.ts';

function block(id: string, type: Block['type'], html = '', extra: Partial<Block> = {}): Block {
  return { id, type, html, indent: 0, ...extra };
}

function page(id: string, title: string, blocks: Block[], extra: Partial<Page> = {}): Page {
  return {
    id, title, icon: null, cover: null, parentId: null, blocks, isFavorite: false, isDeleted: false,
    fullWidth: false, smallText: false, createdAt: 0, updatedAt: 0, ...extra,
  };
}

const leads = page('db1', 'Leads', [], {
  icon: '📇',
  database: {
    id: 'd1',
    properties: [
      { id: 'title', name: 'Name', type: 'text' },
      { id: 'p2', name: 'Stage', type: 'select', options: [{ id: 'o1', name: 'Won', color: 'green' }] },
      { id: 'p3', name: 'Value', type: 'number' },
    ],
    rows: [
      { id: 'r1', pageId: 'rp1', cells: { title: 'Acme <Inc>', p2: 'o1', p3: 1200 } },
      { id: 'r2', pageId: 'rp2', cells: {} },
    ],
    views: [{ id: 'v1', name: 'Table', type: 'table' }],
  },
});

const ctx = {
  pages: { db1: leads, sub: page('sub', 'Sub page', [], { icon: '📄' }) },
  syncedBlocks: { s0: [block('s1', 'paragraph', 'Shared text')] },
  pageUrl: (id: string) => `https://app.test/pub/${id}`,
};

Deno.test('inline marks are rebuilt from a whitelist and everything else is escaped', () => {
  const html = '<b>x</b> <a href="javascript:alert(1)">bad</a> <a href="https://x.test/?a=1&amp;b=2" target="_blank">ok</a> ' +
    '<span class="inline-eq" data-eq="a&lt;b">ab</span> <img src=x onerror=alert(1)> 1 &lt; 2<br><em>y</em>';
  assert.equal(
    inlineHtml(html, ctx),
    '<strong>x</strong> bad <a href="https://x.test/?a=1&amp;b=2">ok</a> <code class="eq">a&lt;b</code>  1 &lt; 2<br><em>y</em>',
  );
  assert.equal(inlineHtml('<a class="mention" data-page="sub" href="/p/sub">Sub</a>', ctx), '<a href="https://app.test/pub/sub">Sub</a>');
  assert.equal(inlineHtml('<script>alert("x")</script>', ctx), 'alert(&quot;x&quot;)');
  assert.equal(inlineHtml('<a href="mailto:a@b.test">mail</a>', ctx), '<a href="mailto:a@b.test">mail</a>');
});

Deno.test('lists nest by indent, to-dos keep their state and numbered lists restart after a break', () => {
  const p = page('p1', 'Lists', [
    block('a', 'bulleted', 'one'),
    block('b', 'bulleted', 'one.one', { indent: 1 }),
    block('c', 'numbered', 'first', { indent: 1 }),
    block('d', 'bulleted', 'two'),
    block('e', 'todo', 'open'),
    block('f', 'todo', 'done', { checked: true }),
    block('g', 'paragraph', 'text'),
    block('h', 'paragraph', 'indented text', { indent: 1 }),
  ]);
  assert.deepEqual(nestByIndent(p.blocks).map((n) => [n.block.id, n.children.map((c) => c.block.id)]), [['a', ['b', 'c']], ['d', []], ['e', []], ['f', []], ['g', ['h']]]);
  assert.equal(
    pageToHtml(p, ctx),
    '<ul><li>one\n<ul><li>one.one</li></ul>\n<ol><li>first</li></ol></li><li>two</li></ul>\n' +
      '<ul class="todo"><li><input type="checkbox" disabled> open</li><li class="done"><input type="checkbox" disabled checked> done</li></ul>\n' +
      '<p>text</p>\n<div class="indent">\n<p>indented text</p>\n</div>',
  );
});

Deno.test('headings, toggles, quotes, callouts, code and dividers', () => {
  const p = page('p1', 'Mixed', [
    block('h1', 'heading1', 'Top'),
    block('h2', 'heading2', 'Middle'),
    block('h3', 'heading3', 'Low'),
    block('t', 'toggle', 'Details', { collapsed: true }),
    block('t1', 'paragraph', 'Hidden', { indent: 1 }),
    block('q', 'quote', 'Said'),
    block('c', 'callout', 'Note', { icon: '💡' }),
    block('k', 'code', 'if (a &lt; b) {}', { language: 'ts' }),
    block('d', 'divider'),
    block('e', 'equation', '', { equation: 'a^2 < b' }),
    block('empty', 'paragraph', ''),
  ]);
  assert.equal(
    pageToHtml(p, ctx),
    '<h2>Top</h2>\n<h3>Middle</h3>\n<h4>Low</h4>\n<details><summary>Details</summary>\n<p>Hidden</p>\n</details>\n<blockquote>Said</blockquote>\n' +
      '<aside class="callout"><span class="emoji">💡</span> Note</aside>\n<pre><code class="language-ts">if (a &lt; b) {}</code></pre>\n<hr>\n<p class="equation">a^2 &lt; b</p>',
  );
  assert.ok(pageToHtml(page('p2', 'Open', [block('t', 'toggle', 'Open')]), ctx).startsWith('<details open>'));
});

Deno.test('media, tables, columns, synced blocks and page links', () => {
  const p = page('p1', 'Media', [
    block('i1', 'image', '', { url: 'https://img.test/a.png', caption: 'A "cap"' }),
    block('i2', 'image', '', { fileId: 'f1', caption: 'Local' }),
    block('b', 'bookmark', '', { url: 'https://site.test', bookmarkTitle: 'Site', bookmarkDescription: 'About' }),
    block('f', 'file', '', { fileId: 'f2', fileName: 'report.pdf' }),
    block('v', 'video', '', { url: 'https://v.test/x.mp4', caption: 'Demo' }),
    block('m', 'embed', '', { url: 'https://figma.test/x', embedProvider: 'figma' }),
    block('tb', 'table', '', { table: [['H1', 'H2'], ['<b>c1</b>']], tableHeaderRow: true }),
    block('col', 'columns', '', { columns: [{ id: 'c1', blocks: [block('c1a', 'paragraph', 'Left')] }, { id: 'c2', blocks: [block('c2a', 'paragraph', 'Right')] }] }),
    block('sy', 'synced', '', { syncedFrom: 's0' }),
    block('pg', 'page', '', { pageId: 'sub' }),
    block('pm', 'page', '', { pageId: 'missing' }),
    block('toc', 'toc'),
  ]);
  const html = pageToHtml(p, ctx);
  assert.ok(html.includes('<figure><img src="https://img.test/a.png" alt="A &quot;cap&quot;"><figcaption>A &quot;cap&quot;</figcaption></figure>'));
  assert.ok(html.includes('<p class="media">Image: Local</p>'));
  assert.ok(html.includes('<p class="media"><a href="https://site.test">Site</a> <span class="muted">About</span></p>'));
  assert.ok(html.includes('<p class="media">report.pdf</p>'));
  assert.ok(html.includes('<p class="media"><a href="https://v.test/x.mp4">Video: Demo</a></p>'));
  assert.ok(html.includes('<p class="media"><a href="https://figma.test/x">Embed (figma)</a></p>'));
  assert.ok(html.includes('<table><tr><th>H1</th><th>H2</th></tr><tr><td><strong>c1</strong></td><td></td></tr></table>'));
  assert.ok(html.includes('<div class="columns"><div class="column">\n<p>Left</p>\n</div><div class="column">\n<p>Right</p>\n</div></div>'));
  assert.ok(html.includes('<p>Shared text</p>'));
  assert.ok(html.includes('<p class="page-link"><a href="https://app.test/pub/sub">📄 Sub page</a></p>'));
  assert.ok(html.includes('<p class="page-link"><a href="https://app.test/pub/missing">Untitled</a></p>'));
  assert.ok(!html.includes('toc'));
});

Deno.test('databases render as a table with computed cells and row links', () => {
  const inline = pageToHtml(page('p1', 'Report', [block('b1', 'database', '', { pageId: 'db1' })]), ctx);
  assert.ok(inline.startsWith('<section class="database"><h3><a href="https://app.test/pub/db1">📇 Leads</a></h3>\n<table><thead><tr><th>Name</th><th>Stage</th><th>Value</th></tr></thead>'));
  assert.ok(inline.includes('<tr><td><a href="https://app.test/pub/rp1">Acme &lt;Inc&gt;</a></td><td>Won</td><td>1,200</td></tr>'));
  assert.ok(inline.includes('<tr><td><a href="https://app.test/pub/rp2">Untitled</a></td><td></td><td></td></tr>'));
  const own = pageToHtml(leads, { ...ctx, maxTableRows: 1 });
  assert.ok(own.startsWith('<table><thead>'));
  assert.ok(own.endsWith('<p class="muted">1 more rows</p>'));
  assert.equal(databaseToHtml({ id: 'x', properties: [], rows: [], views: [] }, ctx), '<p class="muted">Empty database</p>');
});

Deno.test('the description is the first 160 characters of text, cut at a word', () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const p = page('p1', 'Long', [
    block('k', 'code', 'ignored'),
    block('h', 'heading2', ' Intro '),
    block('a', 'paragraph', `<em>${words}</em>`),
  ]);
  const description = pageDescription(p, ctx);
  assert.ok(description.startsWith('Intro word0 word1'));
  assert.ok(description.endsWith('…'));
  assert.ok(description.length <= 160);
  assert.ok(!description.includes('ignored'));
  assert.equal(pageDescription(page('p2', 'Short', [block('a', 'paragraph', 'Just this')]), ctx), 'Just this');
  assert.equal(pageDescription(page('p3', 'Empty', []), ctx), '');
});

Deno.test('the document carries og:image only for an http(s) cover and falls back to a default description', () => {
  const opts = { ...ctx, canonicalUrl: 'https://app.test/pub/p1', markdownUrl: 'https://app.test/pub/p1.md' };
  const gradient = renderPublicPage(page('p1', '', [], { cover: 'linear-gradient(135deg,#667eea,#764ba2)' }), opts);
  assert.ok(gradient.includes('<title>Untitled · colabora.si</title>'));
  assert.ok(gradient.includes('<meta name="description" content="A page published on colabora.si.">'));
  assert.ok(!gradient.includes('og:image'));
  assert.ok(gradient.includes('<meta name="twitter:card" content="summary">'));
  assert.ok(!gradient.includes('article:modified_time'));
  const photo = renderPublicPage(page('p1', 'Photo', [], { cover: 'https://img.test/c.jpg', icon: '🌄' }), { ...opts, updatedAt: Date.UTC(2026, 0, 2) });
  assert.ok(photo.includes('<meta property="og:image" content="https://img.test/c.jpg">'));
  assert.ok(photo.includes('<meta name="twitter:image" content="https://img.test/c.jpg">'));
  assert.ok(photo.includes('<img class="cover" src="https://img.test/c.jpg" alt="">'));
  assert.ok(photo.includes('<header><p class="icon">🌄</p><h1>Photo</h1></header>'));
  assert.ok(photo.includes('<p class="muted">Edited 2026-01-02</p>'));
  assert.ok(!/<script/i.test(photo));
});
