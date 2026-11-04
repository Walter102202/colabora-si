import assert from 'node:assert/strict';
import type { Db, DbResult } from '../db.ts';
import { ToolError } from '../db.ts';
import type { ToolContext } from '../mcp.ts';
import { aiTools } from './ai.ts';
import { meetingTools } from './meeting.ts';
const blocks = [
  { id: 'm', type: 'meeting' },
  { id: 'notes', type: 'heading2', key: 'meeting:notes:m', html: 'Notes' },
  { id: 'n', type: 'paragraph', html: 'Discuss <b>draft</b>' },
  { id: 'summary', type: 'heading2', key: 'meeting:summary:m', html: 'Summary' },
  { id: 'old', type: 'paragraph', html: 'Old summary' },
  { id: 'transcript', type: 'heading2', key: 'meeting:transcript:m', html: 'Transcript' },
  { id: 'turn', type: 'paragraph', html: '<strong>A</strong> [00:12] Send the draft.', turn: { meetingId: 'm', tMs: 12000, speaker: 'A' } },
  { id: 'bad', type: 'paragraph', html: 'Invalid time', turn: { meetingId: 'm', tMs: NaN } },
  { id: 'other', type: 'paragraph', html: 'Other meeting', turn: { meetingId: 'other', tMs: 0 } },
];
function harness(pageBlocks = blocks) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db: Db = {
    download: async () => ({ data: null, error: null }),
    rpc: async <T>(name: string, args: Record<string, unknown>): Promise<DbResult<T>> => { calls.push({ name, args }); return { data: (name === 'get_page_bundle' ? { page: { id: 'p', title: 'Review', blocks: pageBlocks }, pages: {} } : { task_state: 'done' }) as T, error: null }; },
    select: async <T>(spec: { table: string }): Promise<DbResult<T[]>> => ({ data: (spec.table === 'agent_tasks' ? [{ id: 't', request_kind: 'meeting', request: { page_id: 'p', block_id: 'm', lang: 'es' } }] : []) as T[], error: null }),
  };
  const ctx: ToolContext = { db, principal: { type: 'agent', userId: 'u', agentId: 'a', workspaceId: 'w', clientId: null }, signal: new AbortController().signal, appUrl: '', now: () => 0, sleep: async () => {}, progress: () => {} };
  return { ctx, calls };
}
Deno.test('meeting request scopes notes and finite transcript turns to its recorder', async () => {
  const h = harness();
  const out = await aiTools.find(t => t.name === 'get_ai_request')!.handler({ task_id: 't' }, h.ctx);
  assert.deepEqual(out.structured, { kind: 'meeting', task_id: 't', page_id: 'p', block_id: 'm', lang: 'es', title: 'Review', notes_markdown: 'Discuss **draft**', summary_after_block_id: 'summary', transcript: [{ block_id: 'turn', t_ms: 12000, speaker: 'A', text: 'Send the draft.' }] });
});
Deno.test('meeting request refuses empty transcript and missing section boundaries', async () => {
  for (const pageBlocks of [blocks.slice(0, 6), blocks.filter(b => b.id !== 'summary')]) {
    await assert.rejects(() => aiTools.find(t => t.name === 'get_ai_request')!.handler({ task_id: 't' }, harness(pageBlocks).ctx), (e: unknown) => e instanceof ToolError && ['transcript_empty', 'meeting_sections_missing'].includes(e.code));
  }
});
Deno.test('meeting completion forwards usage and idempotency to the owning-run RPC', async () => {
  const h = harness(), usage = { input_tokens: 10, output_tokens: 5, cost_usd: 0.1 };
  await meetingTools[0].handler({ run_id: 'r', usage, idempotency_key: 'k' }, h.ctx);
  assert.deepEqual(h.calls, [{ name: 'complete_meeting_summary', args: { p_run_id: 'r', p_usage: usage, p_idempotency_key: 'k' } }]);
});
