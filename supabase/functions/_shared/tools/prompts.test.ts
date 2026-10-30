import assert from 'node:assert/strict';
import { PROMPTS } from './prompts.ts';
Deno.test('review_as_lead keeps its name and addresses the reviewer agent too', () => {
  const p = PROMPTS.find((x) => x.name === 'review_as_lead')!;
  assert.equal(p.title, 'Review a subtask as Lead or reviewer');
  assert.match(p.description, /reviewer/);
});

Deno.test('continue_task asks to claim with resume', async () => {
  const ctx: import('../mcp.ts').ToolContext = {
    db: { download: async () => ({ data: null, error: null }), rpc: () => Promise.resolve({ data: null, error: null }), select: <T>(spec: import('../db.ts').SelectSpec) => Promise.resolve({ data: (spec.table === 'agent_tasks' ? [{ id: 't1', row_page_id: 'p1', brief_version: 1 }] : []) as T[], error: null }) },
    principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w', clientId: null },
    signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: () => Promise.resolve(), progress: () => {},
  };
  const out = await PROMPTS.find(x => x.name === 'continue_task')!.get({ task_id: 't1' }, ctx);
  const message = out.messages[0] as { content: { text: string } };
  assert.match(message.content.text, /claim_task\("t1", resume: true\)/);
});

Deno.test('CI prompts ask for a commit and leave the result to GitHub', async () => {
  const ctx: import('../mcp.ts').ToolContext = {
    db: { download: async () => ({ data: null, error: null }), rpc: () => Promise.resolve({ data: null, error: null }), select: <T>(spec: import('../db.ts').SelectSpec) => Promise.resolve({
      data: (spec.table === 'agent_tasks' ? [{ id: 't1', row_page_id: 'p1', brief_version: 1 }] : spec.table === 'task_briefs'
        ? [{ done_when: [{ id: 'c1', text: 'CI', check: 'ci', command: 'check' }] }] : []) as T[], error: null }) },
    principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w', clientId: null },
    signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: () => Promise.resolve(), progress: () => {},
  };
  for (const name of ['continue_task', 'review_as_lead']) {
    const out = await PROMPTS.find(x => x.name === name)!.get({ task_id: 't1' }, ctx);
    const message = out.messages[0] as { content: { text: string } };
    assert.match(message.content.text, /Deliver a diff artifact with ref owner\/repo@<full sha>/);
    assert.match(message.content.text, /GitHub reports the result; do not state it yourself/);
  }
});
