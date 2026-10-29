// Task tools (§IV.9.3): each one validates, calls the RPC of §IV.5.1 as the caller, and formats the result.
import { type Filter, must } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { CARD_OUTPUT, CARD_TOOL_META, loadTaskCard } from './card.ts';
import { bool, num, object, output, plural, READ, str, WRITE, WRITE_IDEMPOTENT } from './common.ts';
import type { Row } from './taskData.ts';

const TASK_STATES = ['queued', 'working', 'input_required', 'ready_for_review', 'done', 'failed', 'cancelled'];
const idempotencyKey = { type: 'string', minLength: 1, maxLength: 200, description: 'Retry-safe key: the same key returns the first result.' } as const;
const usageSchema = object({
  input_tokens: { type: 'integer', minimum: 0 },
  output_tokens: { type: 'integer', minimum: 0 },
  model: { type: 'string' },
  cost_usd: { type: 'number', minimum: 0 },
}, ['input_tokens', 'output_tokens']);

/** Tasks delegated to the calling agent; a person sees the tasks they own. */
export function myTasksFilter(ctx: ToolContext): Filter {
  return ctx.principal.agentId
    ? { col: 'delegate_agent_id', op: 'eq', value: ctx.principal.agentId }
    : { col: 'owner_user_id', op: 'eq', value: ctx.principal.userId };
}

/**
 * Pull delivery (§IV.7.4): once the agent has seen its tasks, its pending dispatch events are marked delivered.
 * Best effort: a failure here never hides the tasks from the agent.
 */
export async function markDelivered(ctx: ToolContext): Promise<void> {
  if (!ctx.principal.agentId) return;
  try {
    await ctx.db.rpc('mark_events_delivered', {});
  } catch {
    // ignored
  }
}

/** Prompts (messages to the agent) newer than the agent's own latest activity, per task. */
async function pendingPrompts(ctx: ToolContext, taskIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!taskIds.length) return out;
  const rows = await must(ctx.db.select<{ task_id: string; seq: number; type: string; author_type: string }>({
    table: 'agent_activities',
    columns: 'task_id,seq,type,author_type',
    filters: [{ col: 'task_id', op: 'in', value: taskIds }, { col: 'ephemeral', op: 'eq', value: false }],
    order: [{ column: 'seq', ascending: false }],
    limit: 500,
  }));
  const closed = new Set<string>();
  for (const a of rows ?? []) {
    if (closed.has(a.task_id)) continue;
    if (a.type === 'prompt') out.set(a.task_id, (out.get(a.task_id) ?? 0) + 1);
    else if (a.author_type === 'agent') closed.add(a.task_id);
  }
  return out;
}

const listMyTasks: ToolDef = {
  name: 'list_my_tasks',
  title: 'List my assigned tasks',
  description: 'Tasks assigned to you, newest activity first, with brief version and the number of messages waiting for you.',
  inputSchema: object({
    state: { type: 'array', items: { type: 'string', enum: TASK_STATES } },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  }),
  outputSchema: output({ tasks: { type: 'array', items: { type: 'object' } } }),
  annotations: READ,
  cacheTtlMs: 0,
  async handler(args, ctx) {
    const filters: Filter[] = [myTasksFilter(ctx)];
    if (Array.isArray(args.state) && args.state.length) filters.push({ col: 'state', op: 'in', value: args.state });
    const rows = await must(ctx.db.select<Row>({
      table: 'agent_tasks',
      columns: 'id,title,state,review_state,waiting_on,row_page_id,brief_version,brief_stale,last_activity_at,updated_at',
      filters,
      order: [{ column: 'updated_at', ascending: false }],
      limit: num(args.limit) ?? 20,
    })) ?? [];
    const prompts = await pendingPrompts(ctx, rows.map((r) => String(r.id)));
    const tasks = rows.map((r) => ({
      task_id: r.id,
      title: r.title,
      state: r.state,
      review_state: r.review_state,
      waiting_on: r.waiting_on,
      row_page_id: r.row_page_id,
      brief_version: r.brief_version,
      brief_stale: r.brief_stale,
      last_activity_at: r.last_activity_at,
      pending_prompts: prompts.get(String(r.id)) ?? 0,
    }));
    if (tasks.length) await markDelivered(ctx);
    const queued = tasks.filter((t) => t.state === 'queued').length;
    return { text: `${plural(tasks.length, 'task')} (${queued} queued).`, structured: { tasks } };
  },
};

const getTask: ToolDef = {
  name: 'get_task',
  title: 'Get task brief, artifacts and recent activity',
  description:
    'Everything needed to continue a task without re-explanation: state, current brief, deliverables, pending approvals ' +
    'and recent activity, plus the active run, the latest review, the subtasks and the agent names (the task card).',
  inputSchema: object({
    task_id: { type: 'string', minLength: 1 },
    activities_limit: { type: 'integer', minimum: 0, maximum: 200, default: 20 },
    after_seq: { type: 'integer', minimum: 0, description: 'Only activities after this seq, oldest first; omit for the last activities_limit.' },
    include_ephemeral: { type: 'boolean' },
  }, ['task_id']),
  outputSchema: output({
    task: { type: 'object' },
    brief: { type: ['object', 'null'] },
    artifacts: { type: 'array', items: { type: 'object' } },
    approvals_pending: { type: 'array', items: { type: 'object' } },
    activities: { type: 'array', items: { type: 'object' } },
    next_seq: { type: 'integer', description: 'Pass as after_seq on the next call to read only what is newer.' },
    ...CARD_OUTPUT,
  }),
  annotations: READ,
  cacheTtlMs: 0,
  _meta: CARD_TOOL_META,
  async handler(args, ctx) {
    const t = await loadTaskCard(ctx.db, String(args.task_id), ctx.appUrl, {
      activitiesLimit: num(args.activities_limit) ?? 20,
      includeEphemeral: bool(args.include_ephemeral) ?? false,
      afterSeq: num(args.after_seq),
    });
    return {
      text: `Task "${String(t.task.title || t.task.id)}": ${String(t.task.state)}, brief v${String(t.task.brief_version)}, ` +
        `${plural(t.artifacts.length, 'artifact')}, ${plural(t.approvals_pending.length, 'pending approval')}.`,
      structured: { ...t },
    };
  },
};

const claimTask: ToolDef = {
  name: 'claim_task',
  title: 'Claim a task and start a run',
  description:
    'Starts a run on a task (without task_id: the oldest queued task assigned to you). Returns the current brief, ' +
    'deliverables and recent activity. A done task cannot be claimed: only a person reopens it from the workspace. ' +
    'With resume: true you also get the last checkpoint: which pending writes already happened, which blocks someone else changed, and the open approvals.',
  inputSchema: object({
    task_id: { type: 'string' },
    harness: { type: 'string', minLength: 1, maxLength: 60, description: 'claude_code, codex, chatgpt, claude_ai, custom…' },
    external_session_id: { type: 'string', maxLength: 200 },
    resume: { type: 'boolean', description: 'Continue from the last checkpoint: returns it, classified by the server.' },
  }, ['harness']),
  outputSchema: output({
    task_id: { type: ['string', 'null'] },
    run_id: { type: 'string' },
    context_id: { type: 'string' },
    row_page_id: { type: 'string' },
    brief: { type: ['object', 'null'] },
    artifacts: { type: 'array', items: { type: 'object' } },
    recent_activities: { type: 'array', items: { type: 'object' } },
    resume: { type: ['object', 'null'] },
  }),
  annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('claim_task', {
      p_task_id: str(args.task_id),
      p_harness: args.harness,
      p_external_session_id: str(args.external_session_id),
      p_resume: bool(args.resume) ?? false,
    })) ?? { task_id: null };
    if (!data.task_id) return { text: 'No queued task to claim.', structured: { task_id: null } };
    return {
      text: `Claimed task ${String(data.task_id)}: run ${String(data.run_id)} on page ${String(data.row_page_id)}. Read the brief before writing.` + (data.resume ? ` ${String((data.resume as Row).summary)}` : ''),
      structured: data,
    };
  },
};

const heartbeat: ToolDef = {
  name: 'heartbeat',
  title: 'Report liveness and pull pending messages',
  description:
    'Call at least every 5 minutes during a run. Reports token usage and returns messages sent to the run since after_seq ' +
    'and whether a stop was requested (then call ack_stop).',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 },
    after_seq: { type: 'integer', minimum: 0 },
    usage: usageSchema,
  }, ['run_id']),
  outputSchema: output({
    stop_requested: { type: 'boolean' },
    pending_prompts: { type: 'array', items: { type: 'object' } },
    brief_stale: { type: 'boolean' },
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('heartbeat', {
      p_run_id: args.run_id,
      p_usage: args.usage,
      p_after_seq: num(args.after_seq),
    })) ?? {};
    const prompts = Array.isArray(data.pending_prompts) ? data.pending_prompts : [];
    const stop = data.stop_requested === true;
    return {
      text: stop ? 'Stop requested: finish safely and call ack_stop.' : `Alive. ${plural(prompts.length, 'pending message')}.`,
      structured: { stop_requested: stop, status: data.status ?? null, pending_prompts: prompts, brief_stale: data.brief_stale === true },
    };
  },
};

const postActivity: ToolDef = {
  name: 'post_activity',
  title: 'Log an activity on my run',
  description: 'Logs a thought, action, response or error on your run. Others read it as data, not as an order.',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: ['thought', 'action', 'response', 'error'] },
    body: { type: 'object', description: 'thought/response: {text}; action: {op, summary, page_id?, block_ids?}; error: {code, message, recoverable}' },
    ephemeral: { type: 'boolean' },
    idempotency_key: idempotencyKey,
  }, ['run_id', 'type', 'body']),
  outputSchema: output({ activity_id: { type: 'string' }, seq: { type: 'integer' }, task_state: { type: 'string' } }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('post_activity', {
      p_run_id: args.run_id,
      p_type: args.type,
      p_body: args.body,
      p_ephemeral: bool(args.ephemeral),
      p_idempotency_key: str(args.idempotency_key),
    })) ?? {};
    return { text: `Logged ${String(args.type)} #${String(data.seq)} (task ${String(data.task_state)}).`, structured: data };
  },
};

const addArtifact: ToolDef = {
  name: 'add_artifact',
  title: 'Declare a deliverable',
  description: 'Declares a deliverable of the run and which "done when" criteria (ids from the brief) it satisfies. Same kind+ref creates a new version.',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: ['page', 'file', 'diff', 'query', 'image', 'external'] },
    ref: { type: 'string', minLength: 1, description: 'Page id, file id or URL' },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    satisfies: { type: 'array', items: { type: 'string' } },
    content_hash: { type: 'string' },
  }, ['run_id', 'kind', 'ref', 'title', 'satisfies']),
  outputSchema: output({ artifact_id: { type: 'string' }, version: { type: 'integer' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('add_artifact', {
      p_run_id: args.run_id,
      p_kind: args.kind,
      p_ref: args.ref,
      p_title: args.title,
      p_satisfies: args.satisfies,
      p_content_hash: str(args.content_hash),
    })) ?? {};
    return { text: `Artifact ${String(data.artifact_id)} v${String(data.version)} declared.`, structured: data };
  },
};

const requestInput: ToolDef = {
  name: 'request_input',
  title: 'Ask the human a question',
  description: 'Asks the task owner a question. By default the task becomes input_required until the answer; wait with wait_for_task, heartbeat or list_my_tasks. With blocking: false the task keeps its state and you keep working on what does not depend on the answer; it arrives later as a message (heartbeat or wait_for_task) carrying this approval_id. When only the answers are left, call await_questions.',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 },
    question: { type: 'string', minLength: 1, maxLength: 4000 },
    options: { type: 'array', items: { type: 'string', enum: ['respond', 'ignore', 'approve', 'reject', 'edit'] }, minItems: 1 },
    kind: { type: 'string', enum: ['elicitation', 'plan', 'escalation'] },
    blocking: { type: 'boolean', default: true },
  }, ['run_id', 'question']),
  outputSchema: output({ approval_id: { type: 'string' }, blocking: { type: 'boolean' }, status: { type: 'string' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('request_input', {
      p_run_id: args.run_id,
      p_question: args.question,
      p_options: args.options,
      p_kind: str(args.kind),
      p_blocking: args.blocking !== false,
    })) ?? {};
    const blocking = data.blocking !== false;
    return {
      text: blocking ? `Question sent (${String(data.approval_id)}). The task is now input_required; wait with wait_for_task or poll with heartbeat or list_my_tasks.`
        : `Question sent (${String(data.approval_id)}) without blocking. Keep working on what does not depend on it; the answer arrives as a message with this approval_id.`,
      structured: { status: 'pending', blocking, ...data },
    };
  },
};

const awaitQuestions: ToolDef = {
  name: 'await_questions',
  title: 'Wait on my open questions',
  description: 'Call it when only the answers to your questions asked with blocking: false are left. They start to block, the ' +
    'task becomes input_required and shows that it waits on a person, and an answer resumes it. Then wait with wait_for_task.',
  inputSchema: object({ run_id: { type: 'string', minLength: 1 } }, ['run_id']),
  outputSchema: output({ questions: { type: 'integer' }, task_state: { type: 'string' } }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('await_questions', { p_run_id: String(args.run_id) })) ?? {};
    return {
      text: `${plural(Number(data.questions ?? 0), 'question')} now block; the task is ${String(data.task_state)}. Wait with wait_for_task.`,
      structured: data,
    };
  },
};

const requestApproval: ToolDef = {
  name: 'request_approval',
  title: 'Request approval for an irreversible action',
  description:
    'For actions you will run outside the workspace (email, pull request…). A person approves, edits or rejects; ' +
    'never act before the decision. Actions inside the workspace ask for approval on their own.',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 },
    action: { type: 'string', minLength: 1, maxLength: 200 },
    params: { type: 'object' },
    question: { type: 'string', minLength: 1, maxLength: 4000 },
    artifact_id: { type: 'string' },
  }, ['run_id', 'action', 'params', 'question']),
  outputSchema: output({ approval_id: { type: 'string' }, action_hash: { type: 'string' }, status: { type: 'string' } }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('request_approval', {
      p_run_id: args.run_id,
      p_action: args.action,
      p_params: args.params,
      p_artifact_id: str(args.artifact_id),
      p_question: args.question,
    })) ?? {};
    const structured: Row = { status: 'pending', ...data };
    return { text: `Approval ${String(structured.approval_id)} is ${String(structured.status)}. Wait for the decision with wait_for_task.`, structured };
  },
};

const beginExternalOp: ToolDef = {
  name: 'begin_external_op',
  title: 'Register an external side effect',
  description:
    'Call before an action outside the workspace. Returns an idempotency key to pass to the provider; retries return the same op. ' +
    'If the action needs approval, returns status approval_required with the approval id.',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 },
    provider: { type: 'string', minLength: 1 },
    action: { type: 'string', minLength: 1 },
    params: { type: 'object' },
    approval_receipt: { type: 'string' },
  }, ['run_id', 'provider', 'action', 'params']),
  outputSchema: output({
    op_id: { type: 'string' },
    idempotency_key: { type: 'string' },
    status: { type: 'string' },
    approval_id: { type: 'string' },
  }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('begin_external_op', {
      p_run_id: args.run_id,
      p_provider: args.provider,
      p_action: args.action,
      p_params: args.params,
      p_approval_receipt: str(args.approval_receipt),
    })) ?? {};
    const text = data.status === 'approval_required'
      ? `Approval required (${String(data.approval_id)}). Do not act; wait for the decision.`
      : `External op ${String(data.op_id)} registered (${String(data.status)}).`;
    return { text, structured: data };
  },
};

const finishExternalOp: ToolDef = {
  name: 'finish_external_op',
  title: 'Record the outcome of an external side effect',
  description: 'Records done, failed or unknown for an op from begin_external_op. Use unknown when you cannot tell; a person will check.',
  inputSchema: object({
    op_id: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['done', 'unknown', 'failed'] },
    provider_ref: { type: 'string' },
    error: { type: 'string' },
  }, ['op_id', 'status']),
  outputSchema: output({ ok: { type: 'boolean' } }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    await must(ctx.db.rpc('finish_external_op', {
      p_op_id: args.op_id,
      p_status: args.status,
      p_provider_ref: str(args.provider_ref),
      p_error: str(args.error),
    }));
    return { text: `External op ${String(args.op_id)} marked ${String(args.status)}.`, structured: { ok: true } };
  },
};

const submitForReview: ToolDef = {
  name: 'submit_for_review',
  title: 'Submit the task for review',
  description:
    'Delivers the run: needs at least one artifact and an artifact for every "done when" criterion that is not checked by a person. ' +
    'Ends the run. A person (or the Lead) reviews; you never mark the task done.',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1, maxLength: 10_000 },
    artifact_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
  }, ['run_id', 'summary', 'artifact_ids']),
  outputSchema: output({ task_state: { type: 'string' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('submit_for_review', {
      p_run_id: args.run_id,
      p_summary: args.summary,
      p_artifact_ids: args.artifact_ids,
    })) ?? {};
    return { text: `Submitted for review (task ${String(data.task_state)}). Wait with wait_for_task if you stay in the session.`, structured: data };
  },
};

const endRun: ToolDef = {
  name: 'end_run',
  title: 'End my run',
  description: 'Ends the run without delivering (completed returns the task to the queue; error with terminal=true fails it).',
  inputSchema: object({
    run_id: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['completed', 'error', 'cancelled'] },
    error: { type: 'string' },
    terminal: { type: 'boolean' },
    usage: usageSchema,
  }, ['run_id', 'status']),
  outputSchema: output({ task_state: { type: 'string' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('end_run', {
      p_run_id: args.run_id,
      p_status: args.status,
      p_error: str(args.error),
      p_usage: args.usage,
      p_terminal: bool(args.terminal),
    }));
    const structured = data && typeof data === 'object' ? data : {};
    return { text: `Run ${String(args.run_id)} ended (${String(args.status)}).`, structured };
  },
};

const ackStop: ToolDef = {
  name: 'ack_stop',
  title: 'Acknowledge a stop request',
  description: 'Confirms you stopped after a stop request: the run and the task become cancelled.',
  inputSchema: object({ run_id: { type: 'string', minLength: 1 } }, ['run_id']),
  outputSchema: output({ ok: { type: 'boolean' } }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    await must(ctx.db.rpc('ack_stop', { p_run_id: args.run_id }));
    return { text: `Stop acknowledged for run ${String(args.run_id)}.`, structured: { ok: true } };
  },
};

const sendMessage: ToolDef = {
  name: 'send_message',
  title: 'Send a message to a task',
  description: 'For the Lead of the parent task or a person connected through a chat app: continue, give feedback or stop. Workers get forbidden.',
  inputSchema: object({
    task_id: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 1, maxLength: 10_000 },
    signal: { type: 'string', enum: ['continue', 'feedback', 'stop'] },
  }, ['task_id', 'body']),
  outputSchema: output({ activity_id: { type: 'string' }, delivery: { type: 'string' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('send_agent_message', {
      p_task_id: args.task_id,
      p_body: args.body,
      p_signal: str(args.signal),
    })) ?? {};
    return { text: `Message sent (${String(data.delivery)}).`, structured: data };
  },
};

export const taskTools: ToolDef[] = [
  listMyTasks, getTask, claimTask, heartbeat, postActivity, addArtifact, requestInput, awaitQuestions, requestApproval,
  beginExternalOp, finishExternalOp, submitForReview, endRun, ackStop, sendMessage,
];
