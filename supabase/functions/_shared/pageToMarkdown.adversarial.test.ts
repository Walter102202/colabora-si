import assert from 'node:assert/strict';
import type { Block, Page } from './lib/types.ts';
import { pageToMarkdown } from './pageToMarkdown.ts';

type Entry = { id: string; surface: string; input: string; mustNotContain: string[]; mustContain?: string[] };
// deno task test runs with --allow-read without restriction (deno.json), so the corpus is read from the repo root.
const corpus = JSON.parse(await Deno.readTextFile(new URL('../../../tests/agents/corpus/adversarial.json', import.meta.url))) as Entry[];
const pages = corpus.filter((e) => e.surface === 'page');

const page = (html: string): Page => ({
  id: 'p1', title: 'Adversarial', icon: null, cover: null, parentId: null, isFavorite: false, isDeleted: false,
  fullWidth: false, smallText: false, createdAt: 0, updatedAt: 0,
  blocks: [{ id: 'b1', type: 'paragraph', html, indent: 0 } as Block],
});

for (const e of pages) {
  Deno.test(`pageToMarkdown renders page content as data: ${e.id}`, () => {
    const md = pageToMarkdown(page(e.input), { pages: {}, syncedBlocks: {}, linkBase: '' });
    for (const t of e.mustNotContain) assert.ok(!md.markdown.includes(t), `${e.id} must not contain ${JSON.stringify(t)}: ${md.markdown}`);
    for (const t of e.mustContain ?? []) assert.ok(md.markdown.includes(t), `${e.id} must contain ${JSON.stringify(t)}`);
    assert.equal(md.blocks.length, 1);
    assert.ok(md.blocks[0].markdown.endsWith('<!-- block:b1 -->'), 'the only anchor is the real block id');
  });
}
