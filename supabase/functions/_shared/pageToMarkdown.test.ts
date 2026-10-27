import assert from 'node:assert/strict';
import type { Block, Page } from './lib/types.ts';
import { blocksWithText, decodeCursor, htmlToMarkdown, pageToMarkdown } from './pageToMarkdown.ts';

function block(id: string, type: Block['type'], html = '', extra: Partial<Block> = {}): Block {
  return { id, type, html, indent: 0, ...extra };
}

function page(id: string, title: string, blocks: Block[], extra: Partial<Page> = {}): Page {
  return {
    id, title, icon: null, cover: null, parentId: null, blocks, isFavorite: false, isDeleted: false,
    fullWidth: false, smallText: false, createdAt: 0, updatedAt: 0, ...extra,
  };
}

const tasksDb = page('db1', 'Leads', [], {
  database: {
    id: 'd1',
    properties: [
      { id: 'title', name: 'Name', type: 'text' },
      { id: 'p2', name: 'Stage', type: 'select', options: [{ id: 'o1', name: 'Won', color: 'green' }] },
      { id: 'p3', name: 'Value', type: 'number' },
    ],
    rows: [
      { id: 'r1', pageId: 'rp1', cells: { title: 'Acme', p2: 'o1', p3: 1200 } },
      { id: 'r2', pageId: 'rp2', cells: { title: 'Beta | Co' } },
    ],
    views: [{ id: 'v1', name: 'Table', type: 'table' }],
  },
});

const ctx = { pages: { db1: tasksDb }, syncedBlocks: { s0: [block('s1', 'paragraph', 'Shared text')] }, linkBase: '' };

Deno.test('each block ends with its anchor and inline HTML becomes Markdown', () => {
  const p = page('p1', 'Plan', [
    block('a1', 'heading2', 'Findings'),
    block('a2', 'paragraph', '<strong>Bold</strong> and <a href="https://x.test">link</a> &amp; <code>a 2 b</code>'),
    block('a3', 'todo', 'Ship', { checked: true, indent: 1 }),
    block('a4', 'numbered', 'one'),
    block('a5', 'numbered', 'two'),
    block('a6', 'code', 'if (a &lt; b) {}', { language: 'ts' }),
  ]);
  const md = pageToMarkdown(p, ctx);
  assert.equal(md.blocks.length, 6);
  assert.equal(md.blocks[0].markdown, '## Findings <!-- block:a1 -->');
  assert.equal(md.blocks[1].markdown, '**Bold** and [link](https://x.test) & `a 2 b` <!-- block:a2 -->');
  assert.equal(md.blocks[2].markdown, '  - [x] Ship <!-- block:a3 -->');
  assert.equal(md.blocks[4].markdown, '2. two <!-- block:a5 -->');
  assert.equal(md.blocks[5].markdown, '```ts\nif (a < b) {}\n``` <!-- block:a6 -->');
  assert.ok(md.markdown.startsWith('# Plan'));
  assert.equal(md.next_cursor, undefined);
});

Deno.test('embedded database renders as a Markdown table', () => {
  const p = page('p1', 'Report', [block('b1', 'database', '', { pageId: 'db1' })]);
  const md = pageToMarkdown(p, ctx);
  const text = md.blocks[0].markdown;
  assert.ok(text.startsWith('**Database: [Leads](/p/db1)**'));
  assert.ok(text.includes('| Name | Stage | Value |'));
  assert.ok(text.includes("| Acme | Won | 1,200 |"));
  assert.ok(text.includes('| Beta \\| Co |  |  |'));
});

Deno.test('columns, synced and embed blocks are listed in unknown_block_ids', () => {
  const p = page('p1', 'Mixed', [
    block('c1', 'columns', '', { columns: [{ id: 'col1', blocks: [block('c1a', 'paragraph', 'Left')] }] }),
    block('sy', 'synced', '', { syncedFrom: 's0' }),
    block('e1', 'embed', '', { url: 'https://embed.test' }),
    block('ok', 'paragraph', 'Plain'),
  ]);
  const md = pageToMarkdown(p, ctx);
  assert.deepEqual(md.unknown_block_ids, ['c1', 'sy', 'e1']);
  assert.ok(md.blocks[0].markdown.includes('Left <!-- block:c1a -->'));
  assert.ok(md.blocks[1].markdown.includes('Shared text <!-- block:s1 -->'));
  const texts = blocksWithText(p).map((b) => b.block.id);
  assert.ok(texts.includes('c1a'));
});

Deno.test('cursor pages through blocks and keeps numbering', () => {
  const blocks = Array.from({ length: 5 }, (_, i) => block(`n${i}`, 'numbered', `item ${i}`, { rev: i + 1 }));
  const p = page('p1', 'List', blocks);
  const first = pageToMarkdown(p, { ...ctx, maxBlocks: 2 });
  assert.deepEqual(first.blocks.map((b) => b.id), ['n0', 'n1']);
  assert.equal(first.blocks[1].rev, 2);
  assert.ok(first.next_cursor);
  const second = pageToMarkdown(p, { ...ctx, maxBlocks: 2, cursor: first.next_cursor });
  assert.deepEqual(second.blocks.map((b) => b.id), ['n2', 'n3']);
  assert.equal(second.blocks[0].markdown, '3. item 2 <!-- block:n2 -->');
  assert.ok(!second.markdown.startsWith('# List'));
  const last = pageToMarkdown(p, { ...ctx, maxBlocks: 2, cursor: second.next_cursor });
  assert.deepEqual(last.blocks.map((b) => b.id), ['n4']);
  assert.equal(last.next_cursor, undefined);
  assert.equal(decodeCursor('not base64!'), null);
});

Deno.test('mentions and inline equations', () => {
  assert.equal(
    htmlToMarkdown('<a class="mention" data-page="x" href="/p/x">Spec</a> by <span class="mention person-mention" data-user="u">@Ana</span> <span class="inline-eq" data-eq="a^2">a2</span>'),
    '[Spec](/p/x) by @Ana $a^2$',
  );
});
