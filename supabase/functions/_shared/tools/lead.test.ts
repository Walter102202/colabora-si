import assert from 'node:assert/strict';
import { briefBlocks, BRIEF_KEYS } from './lead.ts';

// The app's briefFromRow reads brief sections by block key, so create_task must write the same keys as the row template.
Deno.test('briefBlocks keys its section headings like the Task brief template', () => {
  const blocks = briefBlocks('Map needs', ['Three segments listed', 'Sources cited'], 'No external calls', ['https://x.test']);
  const keyed = blocks.filter((b) => b.key).map((b) => [b.type, b.key]);
  assert.deepEqual(keyed, [
    ['heading2', 'brief:goal'], ['heading2', 'brief:done_when'], ['heading2', 'brief:constraints'], ['heading2', 'brief:sources'],
  ]);
  assert.deepEqual(Object.values(BRIEF_KEYS), keyed.map(([, k]) => k));
  const under = (key: string) => {
    const rest = blocks.slice(blocks.findIndex((b) => b.key === key) + 1);
    const next = rest.findIndex((b) => b.key);
    return next === -1 ? rest : rest.slice(0, next);
  };
  assert.deepEqual(under('brief:done_when').map((b) => b.type), ['todo', 'todo']);
  assert.deepEqual(under('brief:sources').map((b) => b.spans), [['https://x.test']]);
});
