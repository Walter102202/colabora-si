// Task reads under RLS, shared by get_task, the prompts and the task resources.
import { type Db, type Filter, must, ToolError } from '../db.ts';

export type Row = Record<string, unknown>;

export interface TaskBundle {
  task: Row;
  brief: Row | null;
  artifacts: Row[];
  approvals_pending: Row[];
  activities: Row[];
}

export const TASK_COLUMNS =
  'id,workspace_id,context_id,db_page_id,row_page_id,title,delegate_agent_id,owner_user_id,parent_task_id,' +
  'state,review_state,acceptance,waiting_on,brief_version,brief_stale,active_run_id,review_rounds,max_review_rounds,' +
  'cost_usd,last_activity_at,created_at,updated_at,closed_at';

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
    columns: 'version,objective,constraints,done_when,decisions,sources,open_questions,next_step,policies,author_type,created_at',
    filters: [{ col: 'task_id', op: 'eq', value: taskId }, { col: 'version', op: 'eq', value: version }],
    limit: 1,
  }));
  return rows?.[0] ?? null;
}

export async function loadTaskBundle(
  db: Db,
  taskId: string,
  opts: { activitiesLimit?: number; includeEphemeral?: boolean } = {},
): Promise<TaskBundle> {
  const task = await loadTask(db, taskId);
  const activityFilters: Filter[] = [{ col: 'task_id', op: 'eq', value: taskId }];
  if (!opts.includeEphemeral) activityFilters.push({ col: 'ephemeral', op: 'eq', value: false });
  const [brief, artifacts, approvals, activities] = await Promise.all([
    loadBrief(db, taskId, task.brief_version),
    must(db.select<Row>({
      table: 'agent_artifacts',
      columns: 'id,run_id,kind,ref,version,page_revision,title,satisfies,author_type,created_at',
      filters: [{ col: 'task_id', op: 'eq', value: taskId }, { col: 'superseded_by', op: 'is', value: null }],
      order: [{ column: 'created_at', ascending: true }],
    })),
    must(db.select<Row>({
      table: 'agent_approvals',
      columns: 'id,run_id,kind,action,params,question,options,status,expires_at,created_at',
      filters: [{ col: 'task_id', op: 'eq', value: taskId }, { col: 'status', op: 'eq', value: 'pending' }],
      order: [{ column: 'created_at', ascending: true }],
    })),
    must(db.select<Row>({
      table: 'agent_activities',
      columns: 'id,run_id,seq,type,body,ephemeral,author_type,author_id,created_at',
      filters: activityFilters,
      order: [{ column: 'seq', ascending: false }],
      limit: opts.activitiesLimit ?? 20,
    })),
  ]);
  return {
    task,
    brief,
    artifacts: artifacts ?? [],
    approvals_pending: approvals ?? [],
    activities: (activities ?? []).slice().reverse(),
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
