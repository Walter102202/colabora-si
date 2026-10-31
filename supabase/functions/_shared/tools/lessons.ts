// Lesson tools. A correction reaches the platform agent as a request, the agent proposes, and only a person accepts.
import { must } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { object, output, str, WRITE } from './common.ts';
import type { Row } from './taskData.ts';

const runId = { type: 'string', minLength: 1 };
const usage = object({
  input_tokens: { type: 'integer', minimum: 0 }, output_tokens: { type: 'integer', minimum: 0 },
  model: { type: 'string' }, cost_usd: { type: 'number', minimum: 0 },
});

const proposeLesson: ToolDef = {
  name: 'propose_lesson', title: 'Propose a lesson from a correction',
  description: 'Lead tool: proposes one reusable lesson from a correction on your task or request. It stays inert until a person accepts it. The server fills in the source and the scope; a person decides the final scope.',
  inputSchema: object({
    run_id: runId, text: { type: 'string', minLength: 1, maxLength: 600 }, example: { type: 'string', maxLength: 600 },
    scope: { type: 'string', enum: ['context', 'page', 'workspace'] }, supersedes_id: { type: 'string' }, task_id: { type: 'string' },
    idempotency_key: { type: 'string', minLength: 1, maxLength: 200, description: 'Retry-safe key: the same key returns the first result.' },
  }, ['run_id', 'text']),
  outputSchema: output({ lesson_id: { type: 'string' }, status: { type: 'string' }, duplicate: { type: 'boolean' } }), annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('propose_lesson', { p_run_id: args.run_id, p_text: args.text, p_example: str(args.example) ?? '', p_scope: str(args.scope),
      p_supersedes_id: str(args.supersedes_id), p_task_id: str(args.task_id), p_idempotency_key: str(args.idempotency_key) }));
    return { text: 'Lesson proposed. A person decides whether it applies.', structured: data ?? {} };
  },
};

const completeLessonRequest: ToolDef = {
  name: 'complete_lesson_request', title: 'Close a lesson request',
  description: 'Request tool: closes the lesson request of this run, with or without a proposal.',
  inputSchema: object({ run_id: runId, summary: { type: 'string', maxLength: 1000 }, usage }, ['run_id']),
  outputSchema: output({ task_state: { type: 'string' } }), annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('complete_lesson_request', { p_run_id: args.run_id, p_summary: str(args.summary), p_usage: args.usage }));
    return { text: 'Request closed.', structured: data ?? {} };
  },
};

/** A lesson request carries no page grant: its input comes from a definer RPC, never from a page read. */
export async function lessonRequest(taskId: string, ctx: ToolContext) {
  const data = await must(ctx.db.rpc<Row>('lesson_request_context', { p_task_id: taskId })) ?? {};
  return { text: 'Correction ready to read.', structured: data };
}

export const lessonTools: ToolDef[] = [proposeLesson, completeLessonRequest];
