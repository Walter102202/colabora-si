import assert from 'node:assert/strict';
import { briefBlocks, BRIEF_KEYS, leadTools } from './lead.ts';

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

Deno.test('review_task and close_subtask describe the reviewer path without changing their schema', () => {
  const review = leadTools.find((t) => t.name === 'review_task')!;
  const close = leadTools.find((t) => t.name === 'close_subtask')!;
  assert.match(review.description, /review_of/);
  assert.match(close.description, /reviewer/);
  assert.deepEqual(Object.keys(review.inputSchema.properties ?? {}), ['task_id', 'run_id', 'artifact_id', 'verdict', 'findings', 'evidence']); // properties is optional in JsonSchema (jsonSchema.ts:10)
});

Deno.test('review_task says that blocked waits on a person before the worker resumes', () => {
  const review = leadTools.find((t) => t.name === 'review_task')!;
  assert.match(review.description, /blocked means a person must decide/);
  assert.match(review.description, /worker resumes only after their answer/);
});
