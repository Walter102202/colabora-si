// Task reads under RLS, shared by get_task, the prompts and the task resources.
import { type Db, type Filter, must, ToolError } from '../db.ts';

export type Row = Record<string, unknown>;

export interface TaskBundle {
  task: Row;
  brief: Row | null;
  artifacts: Row[];
  approvals_pending: Row[];
  activities: Row[];
  /** Cursor for the next read: the highest activity seq returned, or the one asked for when nothing is newer. */
  next_seq: number;
}

export const TASK_COLUMNS =
  'id,workspace_id,context_id,db_page_id,row_page_id,title,delegate_agent_id,owner_user_id,parent_task_id,depends_on_task_ids,' +
  'state,review_state,acceptance,waiting_on,brief_version,brief_stale,active_run_id,review_rounds,max_review_rounds,' +
  'cost_usd,last_activity_at,created_at,updated_at,closed_at,closed_by';

export async function loadTask(db: Db, taskId: string): Promise<Row> {
  const rows = await must(db.select<Row>({
    table: 'agent_tasks',
    columns: TASK_COLUMNS,
    filters: [{ col: 'id', op: 'eq', value: taskId }],
    limit: 1,
  }));
  const task = rows?.[0];
  if (!task) throw new ToolError('not_found', `Task ${taskId} was not found, or you have no access to it.`);
  return task;
}

export async function loadBrief(db: Db, taskId: string, version: unknown): Promise<Row | null> {
  if (typeof version !== 'number' || version < 1) return null;
  const rows = await must(db.select<Row>({
    table: 'task_briefs',
    columns: 'task_id,version,objective,constraints,done_when,decisions,sources,open_questions,next_step,policies,author_type,created_at',
    filters: [{ col: 'task_id', op: 'eq', value: taskId }, { col: 'version', op: 'eq', value: version }],
    limit: 1,
  }));
  return rows?.[0] ?? null;
}

/**
 * Without `afterSeq`: the last `activitiesLimit` activities, oldest first. With it: only the
 * activities after that seq, oldest first, so a caller can page forward without re-reading.
 */
export async function loadTaskBundle(
  db: Db,
  taskId: string,
  opts: { activitiesLimit?: number; includeEphemeral?: boolean; afterSeq?: number } = {},
): Promise<TaskBundle> {
  const task = await loadTask(db, taskId);
  const paged = opts.afterSeq !== undefined;
  const activityFilters: Filter[] = [{ col: 'task_id', op: 'eq', value: taskId }];
  if (!opts.includeEphemeral) activityFilters.push({ col: 'ephemeral', op: 'eq', value: false });
  if (paged) activityFilters.push({ col: 'seq', op: 'gt', value: opts.afterSeq });
  const [brief, artifacts, approvals, activities] = await Promise.all([
    loadBrief(db, taskId, task.brief_version),
    must(db.select<Row>({
      table: 'agent_artifacts',
      columns: 'id,task_id,run_id,kind,ref,version,page_revision,title,satisfies,author_type,author_id,superseded_by,created_at',
      filters: [{ col: 'task_id', op: 'eq', value: taskId }, { col: 'superseded_by', op: 'is', value: null }],
      order: [{ column: 'created_at', ascending: true }],
    })),
    must(db.select<Row>({
      table: 'agent_approvals',
      columns: 'id,task_id,run_id,kind,action,params,artifact_id,artifact_version,question,options,status,decision,response,' +
        'decided_by,decided_at,expires_at,created_at,blocking',
      filters: [{ col: 'task_id', op: 'eq', value: taskId }, { col: 'status', op: 'eq', value: 'pending' }],
      order: [{ column: 'created_at', ascending: true }],
    })),
    must(db.select<Row>({
      table: 'agent_activities',
      columns: 'id,task_id,run_id,seq,type,body,ephemeral,author_type,author_id,created_at',
      filters: activityFilters,
      order: [{ column: 'seq', ascending: paged }],
      limit: opts.activitiesLimit ?? 20,
    })),
  ]);
  const ordered = paged ? (activities ?? []) : (activities ?? []).slice().reverse();
  const lastSeq = ordered.length ? Number(ordered[ordered.length - 1].seq) : null;
  return {
    task,
    brief,
    artifacts: artifacts ?? [],
    approvals_pending: approvals ?? [],
    activities: ordered,
    next_seq: lastSeq ?? opts.afterSeq ?? 0,
  };
}

/** One line of an activity body for summaries. */
export function excerpt(body: unknown, max = 280): string {
  const b = (body ?? {}) as Row;
  const raw = [b.text, b.summary, b.question, b.message].find((v) => typeof v === 'string' && v) as string | undefined;
  const text = (raw ?? JSON.stringify(body ?? {})).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface DoneWhen {
  id: string;
  text: string;
  check?: string;
  command?: string;
}

export function doneWhen(brief: Row | null): DoneWhen[] {
  return Array.isArray(brief?.done_when) ? brief!.done_when as DoneWhen[] : [];
}

const QUESTION_KINDS = ['elicitation', 'plan', 'escalation'];

/**
 * Questions answered after the task's last run ended, whether they blocked or not (await_questions makes a question
 * block). A new run has not seen them: their activities are older than its cursor. Empty while no run has ended.
 * Readable by the agent once claim_task rebinds them. Approvals of actions are not questions.
 */
export async function answeredQuestions(db: Db, taskId: string): Promise<Row[]> {
  const ended = await must(db.select<Row>({
    table: 'agent_runs',
    columns: 'id,ended_at',
    filters: [{ col: 'task_id', op: 'eq', value: taskId }, { col: 'ended_at', op: 'gt', value: '1970-01-01T00:00:00Z' }],
    order: [{ column: 'ended_at', ascending: false }],
    limit: 1,
  }));
  const since = ended?.[0]?.ended_at;
  if (typeof since !== 'string') return [];
  const rows = await must(db.select<Row>({
    table: 'agent_approvals',
    columns: 'id,question,decision,response,decided_at',
    filters: [
      { col: 'task_id', op: 'eq', value: taskId },
      { col: 'kind', op: 'in', value: QUESTION_KINDS },
      { col: 'status', op: 'eq', value: 'decided' },
      { col: 'decided_at', op: 'gte', value: since },
    ],
    order: [{ column: 'decided_at', ascending: true }],
    limit: 20,
  })) ?? [];
  return rows.map((a) => {
    const text = (a.response as Row | null)?.text;
    return { approval_id: a.id, question: a.question ?? '', decision: a.decision ?? null, text: typeof text === 'string' ? text : '', answered_at: a.decided_at };
  });
}

/** Questions asked with blocking false that still wait for an answer. A run that claims the task waits on them too. */
export async function openQuestions(db: Db, taskId: string): Promise<Row[]> {
  const rows = await must(db.select<Row>({
    table: 'agent_approvals',
    columns: 'id,question,created_at',
    filters: [
      { col: 'task_id', op: 'eq', value: taskId },
      { col: 'blocking', op: 'eq', value: false },
      { col: 'status', op: 'eq', value: 'pending' },
    ],
    order: [{ column: 'created_at', ascending: true }],
    limit: 20,
  })) ?? [];
  return rows.map((a) => ({ approval_id: a.id, question: a.question ?? '', asked_at: a.created_at }));
}
