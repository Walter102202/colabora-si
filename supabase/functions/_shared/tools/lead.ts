// Lead tools (§IV.9.4): create_task, create_subtask, review_task, close_subtask, list_subtasks.
// The RPCs (0006 create_agent_task, 0009) enforce the Lead role; these tools validate, prepare rows and format.
import { type Db, must, ToolError } from '../db.ts';
import type { AgentBlockInput } from '../lib/agentInput.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { num, object, output, plural, READ, str, WRITE } from './common.ts';
import type { Row } from './taskData.ts';

const doneWhenItem = object({
  id: { type: 'string', minLength: 1, maxLength: 60 },
  text: { type: 'string', minLength: 1, maxLength: 2000 },
  check: { type: 'string', enum: ['human', 'deterministic', 'lead', 'ci'] },
  command: { type: 'string' },
}, ['id', 'text']);

const sourceItem = object({
  kind: { type: 'string', enum: ['page', 'url', 'artifact'] },
  ref: { type: 'string', minLength: 1 },
  trust: { type: 'string', enum: ['internal', 'external'] },
}, ['kind', 'ref']);

const span = (text: string): AgentBlockInput['spans'] => [text];

/** Keys of the brief sections in a row page; the app's briefFromRow reads the blocks under each key. */
export const BRIEF_KEYS = { goal: 'brief:goal', done_when: 'brief:done_when', constraints: 'brief:constraints', sources: 'brief:sources' } as const;

/** Row page content mirroring the "Task brief" row template sections (Goal, Done when, Constraints, Sources), keyed like the template. */
export function briefBlocks(goal: string, doneWhen: string[], constraints?: string, sources: string[] = []): AgentBlockInput[] {
  const blocks: AgentBlockInput[] = [
    { type: 'heading2', spans: span('Goal'), key: BRIEF_KEYS.goal },
    { type: 'paragraph', spans: span(goal) },
    { type: 'heading2', spans: span('Done when'), key: BRIEF_KEYS.done_when },
    ...doneWhen.map((text): AgentBlockInput => ({ type: 'todo', spans: span(text), checked: false })),
    { type: 'heading2', spans: span('Constraints'), key: BRIEF_KEYS.constraints },
    { type: 'paragraph', spans: span(constraints ?? '') },
    { type: 'heading2', spans: span('Sources'), key: BRIEF_KEYS.sources },
  ];
  if (sources.length) for (const s of sources) blocks.push({ type: 'bulleted', spans: span(s) });
  else blocks.push({ type: 'paragraph', spans: span('') });
  return blocks;
}

function sourceRef(raw: string): { kind: 'page' | 'url'; ref: string; trust: 'internal' | 'external' } {
  return /^https?:\/\//i.test(raw) ? { kind: 'url', ref: raw, trust: 'external' } : { kind: 'page', ref: raw, trust: 'internal' };
}

/** The "Agent Tasks" database: the first readable database page with an agentStatus property. */
async function defaultTaskDatabase(db: Db): Promise<string> {
  const rows = await must(db.select<{ id: string; props: { type?: string }[] | null }>({
    table: 'pages',
    columns: 'id,props:data->database->properties',
    filters: [{ col: 'deleted_at', op: 'is', value: null }],
    order: [{ column: 'created_at', ascending: true }],
    limit: 500,
  }));
  const hit = (rows ?? []).find((r) => Array.isArray(r.props) && r.props.some((p) => p?.type === 'agentStatus'));
  if (!hit) {
    throw new ToolError('not_found', 'No "Agent Tasks" database is visible to you. Pass `database`, or ask a person to grant you one.');
  }
  return hit.id;
}

async function addTaskRow(ctx: ToolContext, dbId: string, title: string, blocks: AgentBlockInput[], key?: string) {
  const row = await must(ctx.db.rpc<{ row_id: string; page_id: string }>('add_row', {
    p_db_page_id: dbId,
    p_cells: { title: { text: title } },
    p_blocks: blocks,
    p_idempotency_key: key ? `${key}:row` : undefined,
  }));
  if (!row?.page_id) throw new ToolError('internal', 'The row was not created.');
  return row;
}

const createTask: ToolDef = {
  name: 'create_task',
  title: 'Create a task from my session',
  description:
    'Lead only. Creates a task row in the "Agent Tasks" database (or `database`) with the brief written in the page, ' +
    'owned by your sponsor. Without `worker` you lead it yourself and, with claim (default), a run starts at once.',
  inputSchema: object({
    title: { type: 'string', minLength: 1, maxLength: 300 },
    brief: object({
      goal: { type: 'string', minLength: 1, maxLength: 10_000 },
      done_when: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 30 },
      constraints: { type: 'string', maxLength: 10_000 },
      sources: { type: 'array', items: { type: 'string' }, maxItems: 30, description: 'Page ids or URLs' },
    }, ['goal', 'done_when']),
    worker: { type: 'string', description: 'Agent id to delegate the task to' },
    database: { type: 'string', description: 'Page id of the tasks database' },
    claim: { type: 'boolean', default: true },
    harness: { type: 'string', maxLength: 60, default: 'custom' },
    idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
  }, ['title', 'brief']),
  outputSchema: output({ task_id: { type: 'string' }, row_page_id: { type: 'string' }, run_id: { type: 'string' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    if (!ctx.principal.agentId) throw new ToolError('lead_only', 'Only a Lead agent can create tasks with this tool.');
    const brief = args.brief as { goal: string; done_when: string[]; constraints?: string; sources?: string[] };
    const key = str(args.idempotency_key);
    const dbId = str(args.database) ?? await defaultTaskDatabase(ctx.db);
    const row = await addTaskRow(ctx, dbId, String(args.title),
      briefBlocks(brief.goal, brief.done_when, brief.constraints, brief.sources ?? []), key);
    const worker = str(args.worker);
    const created = await must(ctx.db.rpc<Row>('create_agent_task', {
      p_row_page_id: row.page_id,
      p_brief: {
        objective: brief.goal,
        done_when: brief.done_when.map((text, i) => ({ id: `c${i + 1}`, text, check: 'human' })),
        constraints: brief.constraints ?? '',
        sources: (brief.sources ?? []).map(sourceRef),
      },
      p_delegate_agent_id: worker ?? ctx.principal.agentId,
      p_idempotency_key: key,
    })) ?? {};
    const structured: Row = { task_id: created.task_id, row_page_id: row.page_id };
    if (!worker && args.claim !== false) {
      const claim = await must(ctx.db.rpc<Row>('claim_task', {
        p_task_id: created.task_id,
        p_harness: str(args.harness) ?? 'custom',
      })) ?? {};
      structured.run_id = claim.run_id;
    }
    return {
      text: `Task ${String(created.task_id)} created on page ${row.page_id}${structured.run_id ? `; run ${String(structured.run_id)} started` : ''}.`,
      structured,
    };
  },
};

const createSubtask: ToolDef = {
  name: 'create_subtask',
  title: 'Delegate a subtask',
  description:
    'Lead only, on a task you lead. Creates a subtask with its own brief and "done when" criteria, delegated to an agent. ' +
    'Without row_page_id a new row is added to the parent task\'s database. Then wait with wait_for_task.',
  inputSchema: object({
    parent_task_id: { type: 'string', minLength: 1 },
    title: { type: 'string', maxLength: 300 },
    row_page_id: { type: 'string' },
    delegate_agent_id: { type: 'string' },
    brief: object({
      objective: { type: 'string', minLength: 1, maxLength: 10_000 },
      constraints: { type: 'string', maxLength: 10_000 },
      done_when: { type: 'array', items: doneWhenItem, minItems: 1, maxItems: 30 },
      sources: { type: 'array', items: sourceItem, maxItems: 30 },
      next_step: { type: 'string', maxLength: 2000 },
      policies: { type: 'object', description: 'Optional. require_approval: actions that always ask (a list of action names; any shape the server cannot read is refused); preapproved: actions the parent task already allows (a subtask never gets more than its parent). The autonomy level is set by a workspace owner in the app, never in the brief.' },
    }, ['objective', 'done_when']),
    reference_task_ids: { type: 'array', items: { type: 'string' } },
    depends_on_task_ids: { type: 'array', items: { type: 'string' } },
    idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
  }, ['parent_task_id', 'brief']),
  outputSchema: output({ task_id: { type: 'string' }, context_id: { type: 'string' }, row_page_id: { type: 'string' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const brief = args.brief as { objective: string; constraints?: string; done_when: { text: string }[]; sources?: { ref: string }[] };
    const key = str(args.idempotency_key);
    let rowPageId = str(args.row_page_id);
    if (!rowPageId) {
      const parents = await must(ctx.db.select<{ db_page_id: string | null }>({
        table: 'agent_tasks',
        columns: 'db_page_id',
        filters: [{ col: 'id', op: 'eq', value: args.parent_task_id }],
        limit: 1,
      }));
      const parent = parents?.[0];
      if (!parent) throw new ToolError('not_found', `Task ${String(args.parent_task_id)} was not found, or you have no access to it.`);
      if (!parent.db_page_id) throw new ToolError('invalid_input', 'The parent task is not in a database: pass row_page_id.');
      const title = str(args.title) || brief.objective.slice(0, 120);
      const row = await addTaskRow(ctx, parent.db_page_id, title, briefBlocks(
        brief.objective, brief.done_when.map((d) => d.text), brief.constraints, (brief.sources ?? []).map((s) => s.ref),
      ), key);
      rowPageId = row.page_id;
    }
    const data = await must(ctx.db.rpc<Row>('create_subtask', {
      p_parent_task_id: args.parent_task_id,
      p_row_page_id: rowPageId,
      p_brief: args.brief,
      p_delegate_agent_id: str(args.delegate_agent_id),
      p_reference_task_ids: args.reference_task_ids,
      p_depends_on_task_ids: args.depends_on_task_ids,
      p_idempotency_key: key,
    })) ?? {};
    const structured = { task_id: data.task_id, context_id: data.context_id, row_page_id: rowPageId };
    return { text: `Subtask ${String(data.task_id)} created on page ${rowPageId}. Wait for it with wait_for_task.`, structured };
  },
};

const reviewTask: ToolDef = {
  name: 'review_task',
  title: 'Review a subtask deliverable',
  description:
    'Review of a task in ready_for_review: as Lead from your own run on the parent task (run_id), or as a person ' +
    '(no run_id). One finding per "done when" criterion, judged by evidence. changes_requested sends the findings to ' +
    'the worker; past the round limit it escalates to a person. blocked means a person must decide: the task waits on ' +
    'them and the worker resumes only after their answer. approved does not close the task: a person closes it ' +
    '(close_task), or the Lead with close_subtask when the policy allows.' +
    ' As the reviewer agent, call it from your run on the review task delegated to you (its brief policy review_of names task_id); recording the review closes your review task.',
  inputSchema: object({
    task_id: { type: 'string', minLength: 1 },
    run_id: { type: 'string', minLength: 1, description: 'Agents: your active run, on the parent task as Lead or on the review task as reviewer. People omit it.' },
    artifact_id: { type: 'string' },
    verdict: { type: 'string', enum: ['approved', 'changes_requested', 'blocked'] },
    findings: {
      type: 'array',
      items: object({
        criterion_id: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: ['verified', 'not_found', 'contradicted', 'unverified'] },
        note: { type: 'string', maxLength: 4000 },
        evidence_ref: { type: 'string' },
      }, ['criterion_id', 'status']),
    },
    evidence: {
      type: 'array',
      items: object({ kind: { type: 'string' }, ref: { type: 'string' }, hash: { type: 'string' }, command: { type: 'string' } }, ['kind', 'ref']),
    },
  }, ['task_id', 'verdict', 'findings']),
  outputSchema: output({ review_id: { type: 'string' }, task_state: { type: 'string' }, rounds: { type: 'integer' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('review_task', {
      p_task_id: args.task_id,
      p_verdict: args.verdict,
      p_findings: args.findings,
      p_evidence: args.evidence ?? [],
      p_artifact_id: str(args.artifact_id),
      p_run_id: str(args.run_id),
    })) ?? {};
    return {
      text: `Review ${String(data.review_id)}: ${String(args.verdict)}; subtask ${String(data.task_state)} (round ${String(data.rounds)}).`,
      structured: data,
    };
  },
};

const closeSubtask: ToolDef = {
  name: 'close_subtask',
  title: 'Close a reviewed subtask',
  description:
    'Lead, or the reviewer with an active run on its review task. Closes a subtask in ready_for_review when the parent brief allows it (policies.subtask_close = lead) or ' +
    'every deterministic criterion is verified with evidence; CI criteria require a current verified review and a passing GitHub check on the delivered commit. Otherwise policy_denied and a person decides.',
  inputSchema: object({
    task_id: { type: 'string', minLength: 1 },
    verdict: { type: 'string', enum: ['accepted'], default: 'accepted' },
    evidence: { type: 'array', items: { type: 'object' } },
  }, ['task_id']),
  outputSchema: output({ task_state: { type: 'string' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('close_subtask', {
      p_task_id: args.task_id,
      p_verdict: str(args.verdict) ?? 'accepted',
      p_evidence: args.evidence ?? [],
    })) ?? {};
    return { text: `Subtask ${String(args.task_id)} closed (${String(data.task_state)}).`, structured: data };
  },
};

const updateSubtask: ToolDef = {
  name: 'update_subtask',
  title: 'Correct or reassign a subtask',
  description:
    'Lead: change the goal, criteria, constraints, sources, next step, policies, delegate or dependencies of a subtask of your task. ' +
    'Delegate: record decisions, open questions and the next step on your own task. A worker on the task is told the brief changed.',
  inputSchema: object({
    task_id: { type: 'string', minLength: 1 },
    objective: { type: 'string', minLength: 1, maxLength: 10_000 },
    constraints: { type: 'string', maxLength: 10_000 },
    done_when: { type: 'array', items: doneWhenItem, minItems: 1, maxItems: 30 },
    sources: { type: 'array', items: sourceItem, maxItems: 30 },
    next_step: { type: 'string', maxLength: 2000 },
    decisions: { type: 'array', items: { type: 'object' } },
    open_questions: { type: 'array', items: { type: 'object' } },
    policies: { type: 'object' },
    delegate_agent_id: { type: 'string' },
    depends_on_task_ids: { type: 'array', items: { type: 'string' } },
  }, ['task_id']),
  outputSchema: output({ brief_version: { type: 'integer' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const { task_id, ...patch } = args;
    if (Object.keys(patch).length === 0) throw new ToolError('invalid_input', 'Pass at least one field to change.');
    const version = await must(ctx.db.rpc<number>('update_brief', { p_task_id: task_id, p_patch: patch }));
    return { text: `Brief of ${String(task_id)} is now v${String(version)}.`, structured: { brief_version: version } };
  },
};

const listSubtasks: ToolDef = {
  name: 'list_subtasks',
  title: 'List subtasks',
  description: 'Subtasks of a task with their state, review state and dependencies.',
  inputSchema: object({
    parent_task_id: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  }, ['parent_task_id']),
  outputSchema: output({
    tasks: { type: 'array', items: { type: 'object' } },
    dependencies: { type: 'array', items: { type: 'object' } },
  }),
  annotations: READ,
  cacheTtlMs: 0,
  async handler(args, ctx) {
    const rows = await must(ctx.db.select<Row>({
      table: 'list_subtasks',
      columns: 'task_id,title,state,review_state,waiting_on,acceptance,delegate_agent_id,row_page_id,depends_on_task_ids,' +
        'review_rounds,max_review_rounds,brief_version,brief_stale,last_activity_at,created_at',
      filters: [{ col: 'parent_task_id', op: 'eq', value: args.parent_task_id }],
      order: [{ column: 'created_at', ascending: true }],
      limit: num(args.limit) ?? 50,
    })) ?? [];
    const dependencies = rows.flatMap((r) =>
      (Array.isArray(r.depends_on_task_ids) ? r.depends_on_task_ids as string[] : []).map((d) => ({ task_id: r.task_id, depends_on: d }))
    );
    const tasks = rows.map(({ depends_on_task_ids: _deps, ...rest }) => rest);
    const open = tasks.filter((t) => t.state !== 'done' && t.state !== 'cancelled' && t.state !== 'failed').length;
    return { text: `${plural(tasks.length, 'subtask')} (${open} open).`, structured: { tasks, dependencies } };
  },
};

export const leadTools: ToolDef[] = [createTask, createSubtask, updateSubtask, reviewTask, closeSubtask, listSubtasks];
