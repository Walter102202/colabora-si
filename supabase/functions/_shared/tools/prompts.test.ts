import assert from 'node:assert/strict';
import { PROMPTS } from './prompts.ts';
Deno.test('review_as_lead keeps its name and addresses the reviewer agent too', () => {
  const p = PROMPTS.find((x) => x.name === 'review_as_lead')!;
  assert.equal(p.title, 'Review a subtask as Lead or reviewer');
  assert.match(p.description, /reviewer/);
});
