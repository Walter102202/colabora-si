import type { Db } from '../db.ts';
import { must, ToolError } from '../db.ts';
import type { ToolDef } from '../mcp.ts';
import { htmlToMarkdown, htmlToText } from '../pageToMarkdown.ts';
import { loadPage, object, output, str, WRITE } from './common.ts';
import type { Row } from './taskData.ts';

export async function meetingRequest(db: Db, task: Row) {
  const request = task.request as Row;
  const pageId = String(request.page_id), blockId = String(request.block_id);
  const { bundle } = await loadPage(db, pageId);
  const blocks = bundle.page.blocks;
  const recorder = blocks.findIndex(b => b.id === blockId && b.type === 'meeting');
  const notes = blocks.findIndex(b => b.key === `meeting:notes:${blockId}`);
  const summary = blocks.findIndex(b => b.key === `meeting:summary:${blockId}`);
  const transcriptStart = blocks.findIndex(b => b.key === `meeting:transcript:${blockId}`);
  if (recorder < 0 || notes <= recorder || summary <= notes || transcriptStart <= summary
    || blocks.slice(recorder + 1, transcriptStart).some(b => b.type === 'meeting')) {
    throw new ToolError('meeting_sections_missing', 'The meeting sections are missing or out of order.');
  }
  const nextMeeting = blocks.findIndex((b, i) => i > transcriptStart && b.type === 'meeting');
  const transcript = blocks.slice(transcriptStart + 1, nextMeeting < 0 ? undefined : nextMeeting).flatMap(b => {
    const turn = (b as unknown as { turn?: { meetingId?: unknown; tMs?: unknown; speaker?: unknown } }).turn;
    if (turn?.meetingId !== blockId || typeof turn.tMs !== 'number' || !Number.isFinite(turn.tMs) || turn.tMs < 0) return [];
    const text = htmlToText(b.html ?? '').replace(/^.*?\[\d+:\d{2}\]\s*/, '').trim();
    return text ? [{ block_id: b.id, t_ms: turn.tMs, speaker: typeof turn.speaker === 'string' ? turn.speaker : null, text }] : [];
  });
  if (!transcript.length) throw new ToolError('transcript_empty', 'The meeting has no transcript turns.');
  return { text: 'Meeting ready to summarize.', structured: {
    kind: 'meeting', task_id: task.id, page_id: pageId, block_id: blockId, lang: request.lang ?? 'en', title: bundle.page.title,
    notes_markdown: blocks.slice(notes + 1, summary).map(b => htmlToMarkdown(b.html ?? '')).filter(Boolean).join('\n\n'),
    summary_after_block_id: blocks[summary].id, transcript,
  } };
}

export const meetingTools: ToolDef[] = [{
  name: 'complete_meeting_summary', title: 'Complete a meeting summary',
  description: 'Request tool: closes the owning meeting run after its cited summary was appended, recording usage once.',
  inputSchema: object({ run_id: { type: 'string', minLength: 1 },
    usage: object({ input_tokens: { type: 'integer', minimum: 0 }, output_tokens: { type: 'integer', minimum: 0 }, model: { type: 'string' }, cost_usd: { type: 'number', minimum: 0 } }),
    idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
  }, ['run_id', 'usage', 'idempotency_key']),
  outputSchema: output({ task_state: { type: 'string' } }), annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('complete_meeting_summary', { p_run_id: args.run_id, p_usage: args.usage, p_idempotency_key: str(args.idempotency_key) }));
    return { text: 'Meeting summary written.', structured: data ?? {} };
  },
}];
