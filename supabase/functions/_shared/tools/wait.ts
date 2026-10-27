// Waiting tools (§IV.9.7): hold the call until something changes or the timeout passes, by polling under RLS
// every 1.5 s. Cursors are evaluated before sleeping, so nothing is lost between two calls.
import { must, ToolError } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { num, object, output, plural, READ, str } from './common.ts';
import { markDelivered, myTasksFilter } from './tasks.ts';
import { excerpt, type Row } from './taskData.ts';

export const POLL_MS = 1500;
export const MAX_WAIT_S = 120;
export const DEFAULT_WAIT_S = 50;
const PROGRESS_EVERY_MS = 30_000;
const CLOSED = new Set(['done', 'failed', 'cancelled']);

function timeoutOf(args: Record<string, unknown>): number {
  const t = num(args.timeout_s);
  return t === undefined ? DEFAULT_WAIT_S : Math.max(0, Math.min(MAX_WAIT_S, Math.floor(t)));
}

/** Sleeps one poll interval; false when the caller went away (the signal aborted). */
async function nap(ctx: ToolContext, ms: number): Promise<boolean> {
  try {
    await ctx.sleep(ms, ctx.signal);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// wait_for_task
// ---------------------------------------------------------------------------

const WATCHED = ['state', 'review_state', 'waiting_on', 'brief_version', 'review_rounds'] as const;

interface TaskSnapshot {
  task: Row;
  subtasks: Row[];
  activities: Row[];
  maxSeq: number;
  stop: boolean;
}

function fingerprint(s: TaskSnapshot): string {
  const pick = (r: Row) => WATCHED.map((k) => String(r[k] ?? '')).join('|');
  return [pick(s.task), ...s.subtasks.map((t) => `${String(t.id)}:${pick(t)}`)].join('#');
}

async function snapshotTask(ctx: ToolContext, taskId: string, afterSeq: number | undefined, runId?: string): Promise<TaskSnapshot> {
  const cols = 'id,state,review_state,waiting_on,brief_version,review_rounds,active_run_id';
  const [tasks, subtasks, activities, runs] = await Promise.all([
    must(ctx.db.select<Row>({ table: 'agent_tasks', columns: cols, filters: [{ col: 'id', op: 'eq', value: taskId }], limit: 1 })),
    must(ctx.db.select<Row>({
      table: 'agent_tasks',
      columns: cols,
      filters: [{ col: 'parent_task_id', op: 'eq', value: taskId }],
      order: [{ column: 'created_at', ascending: true }],
    })),
    must(ctx.db.select<Row>({
      table: 'agent_activities',
      columns: 'seq,type,author_type,author_id,body,created_at',
      filters: [
        { col: 'task_id', op: 'eq', value: taskId },
        { col: 'ephemeral', op: 'eq', value: false },
        ...(afterSeq === undefined ? [] : [{ col: 'seq', op: 'gt' as const, value: afterSeq }]),
      ],
      order: [{ column: 'seq', ascending: afterSeq !== undefined }],
      limit: afterSeq === undefined ? 1 : 50,
    })),
    runId
      ? must(ctx.db.select<Row>({
        table: 'agent_runs',
        columns: 'id,stop_requested_at,stop_acked_at',
        filters: [{ col: 'id', op: 'eq', value: runId }],
        limit: 1,
      }))
      : Promise.resolve([] as Row[]),
  ]);
  const task = tasks?.[0];
  if (!task) throw new ToolError('not_found', `Task ${taskId} was not found, or you have no access to it.`);
  const acts = activities ?? [];
  const run = runs?.[0];
  return {
    task,
    subtasks: subtasks ?? [],
    activities: afterSeq === undefined ? [] : acts,
    maxSeq: Math.max(afterSeq ?? 0, ...acts.map((a) => Number(a.seq) || 0)),
    stop: !!run && !!run.stop_requested_at && !run.stop_acked_at,
  };
}

function taskView(s: TaskSnapshot) {
  return {
    task_id: s.task.id,
    state: s.task.state,
    review_state: s.task.review_state,
    waiting_on: s.task.waiting_on,
    brief_version: s.task.brief_version,
    review_rounds: s.task.review_rounds,
    active_run_id: s.task.active_run_id,
    subtasks: s.subtasks.map((t) => ({ task_id: t.id, state: t.state, review_state: t.review_state })),
  };
}

function activityView(a: Row) {
  const body = (a.body ?? {}) as Row;
  const out: Record<string, unknown> = {
    seq: a.seq,
    type: a.type,
    author_type: a.author_type,
    author: a.author_id,
    excerpt: excerpt(a.body),
    created_at: a.created_at,
  };
  if (typeof body.signal === 'string') out.signal = body.signal;
  return out;
}

const waitForTask: ToolDef = {
  name: 'wait_for_task',
  title: 'Wait until a task changes',
  description:
    'Holds the call until the task (or one of its direct subtasks) changes, a new activity arrives after after_seq, ' +
    'a stop is requested on run_id, or timeout_s passes (default 50, max 120). Without after_seq it answers at once with ' +
    'the current state and next_seq. With run_id the wait counts as a heartbeat; timeout_s = 0 only registers the wait ' +
    '(use it before ending your turn when something else will wake you). On changed:false call again with next_seq.',
  inputSchema: object({
    task_id: { type: 'string', minLength: 1 },
    after_seq: { type: 'integer', minimum: 0 },
    timeout_s: { type: 'integer', minimum: 0, maximum: MAX_WAIT_S, default: DEFAULT_WAIT_S },
    run_id: { type: 'string' },
  }, ['task_id']),
  outputSchema: output({
    changed: { type: 'boolean' },
    stop_requested: { type: 'boolean' },
    task: { type: 'object' },
    activities: { type: 'array', items: { type: 'object' } },
    next_seq: { type: 'integer' },
    waited_s: { type: 'integer' },
  }),
  annotations: READ,
  cacheTtlMs: 0,
  budgetMs: (args) => timeoutOf(args) * 1000 + 15_000,
  async handler(args, ctx) {
    const taskId = String(args.task_id);
    const afterSeq = num(args.after_seq);
    const runId = str(args.run_id);
    const timeoutS = timeoutOf(args);
    const started = ctx.now();
    const deadline = started + timeoutS * 1000;

    let snap = await snapshotTask(ctx, taskId, afterSeq, runId);
    const baseline = fingerprint(snap);
    const finish = (changed: boolean) => {
      const waited = Math.round((ctx.now() - started) / 1000);
      return {
        text: changed
          ? `Task ${taskId} changed: ${String(snap.task.state)}${snap.activities.length ? `, ${plural(snap.activities.length, 'new activity')}` : ''}${snap.stop ? ', stop requested' : ''}.`
          : `No change on task ${taskId} after ${waited} s. Call again with after_seq ${snap.maxSeq}.`,
        structured: {
          changed,
          stop_requested: snap.stop,
          task: taskView(snap),
          activities: snap.activities.map(activityView),
          next_seq: snap.maxSeq,
          waited_s: waited,
        },
      };
    };

    if (afterSeq === undefined) return finish(false);
    const isChanged = () => snap.activities.length > 0 || snap.stop || fingerprint(snap) !== baseline;

    if (runId) await must(ctx.db.rpc('touch_run_wait', { p_run_id: runId, p_task_id: taskId }));
    if (timeoutS === 0) return finish(isChanged());

    let lastProgress = started;
    try {
      while (!isChanged() && ctx.now() < deadline) {
        if (!await nap(ctx, Math.min(POLL_MS, deadline - ctx.now()))) break;
        if (ctx.now() - lastProgress >= PROGRESS_EVERY_MS) {
          lastProgress = ctx.now();
          ctx.progress(Math.round((lastProgress - started) / 1000), timeoutS, `waiting on task ${taskId}`);
        }
        snap = await snapshotTask(ctx, taskId, afterSeq, runId);
      }
    } finally {
      // Leaving the wait clears waiting_on_task_id; a failure here must not hide the result.
      if (runId) await ctx.db.rpc('touch_run_wait', { p_run_id: runId, p_task_id: null }).catch(() => {});
    }
    return finish(isChanged());
  },
};

// ---------------------------------------------------------------------------
// wait_for_my_tasks
// ---------------------------------------------------------------------------

export type Reason = 'queued' | 'feedback' | 'brief' | 'approval_decided' | 'stop' | 'closed';

interface Cursor {
  /** High-water timestamp (normalized, microseconds, UTC). */
  t: string;
  /** Keys already delivered exactly at `t`. */
  k: string[];
}

/** Postgres timestamps -> "YYYY-MM-DDTHH:MM:SS.ffffffZ", comparable as strings. */
export function normTs(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value.trim());
  if (!m) return value;
  let zone = m[4] ?? 'Z';
  if (zone !== 'Z') zone = /^[+-]\d{2}$/.test(zone) ? `${zone}:00` : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (Number.isNaN(ms)) return value;
  return `${new Date(ms).toISOString().slice(0, 19)}.${(m[3] ?? '').padEnd(6, '0').slice(0, 6)}Z`;
}

export function encodeTaskCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTaskCursor(raw: string): Cursor {
  try {
    const json = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const c = JSON.parse(json);
    if (typeof c?.t === 'string' && Array.isArray(c.k)) return { t: c.t, k: c.k.map(String) };
  } catch {
    // fall through
  }
  throw new ToolError('invalid_input', 'The cursor is not valid. Call wait_for_my_tasks without `after` to get a new one.');
}

const TASK_FIELDS = 'id,title,state,review_state,waiting_on,brief_version,brief_stale,active_run_id,updated_at';

export function reasonFor(task: Row, prompt: Row | undefined): Reason | null {
  if (task.state === 'done' || task.state === 'failed') return 'closed';
  if (task.state === 'cancelled') return 'stop';
  if (prompt) {
    const body = (prompt.body ?? {}) as Row;
    if (body.signal === 'stop') return 'stop';
    if (body.approval_id !== undefined || body.decision !== undefined) return 'approval_decided';
    if (body.signal === 'feedback' || body.signal === 'continue') return 'feedback';
    if (body.signal === 'start' && task.state === 'queued') return 'queued';
  }
  if (task.brief_stale === true) return 'brief';
  if (task.state === 'queued') return 'queued';
  return null;
}

function myTaskView(task: Row, reason: Reason, prompts: number) {
  return {
    task_id: task.id,
    title: task.title,
    state: task.state,
    review_state: task.review_state,
    waiting_on: task.waiting_on,
    brief_version: task.brief_version,
    active_run_id: task.active_run_id,
    pending_prompts: prompts,
    reason,
  };
}

/** Tasks that need the agent right now (no cursor yet), and a cursor at the current high-water mark. */
async function initialState(ctx: ToolContext) {
  const mine = myTasksFilter(ctx);
  const [open, latest, latestPrompt] = await Promise.all([
    must(ctx.db.select<Row>({
      table: 'agent_tasks',
      columns: TASK_FIELDS,
      filters: [mine, { col: 'state', op: 'in', value: ['queued', 'working', 'input_required', 'ready_for_review'] }],
      order: [{ column: 'updated_at', ascending: true }],
      limit: 100,
    })),
    must(ctx.db.select<Row>({
      table: 'agent_tasks',
      columns: 'id,updated_at',
      filters: [mine],
      order: [{ column: 'updated_at', ascending: false }],
      limit: 1,
    })),
    must(ctx.db.select<Row>({
      table: 'agent_activities',
      columns: 'task_id,seq,created_at',
      filters: [{ col: 'type', op: 'eq', value: 'prompt' }],
      order: [{ column: 'created_at', ascending: false }],
      limit: 1,
    })),
  ]);
  const tasks = (open ?? []).flatMap((t) => {
    const reason: Reason | null = t.review_state === 'changes_requested' ? 'feedback' : reasonFor(t, undefined);
    return reason ? [myTaskView(t, reason, 0)] : [];
  });
  const marks = [
    ...(latest ?? []).map((t) => normTs(String(t.updated_at))),
    ...(latestPrompt ?? []).map((a) => normTs(String(a.created_at))),
  ];
  const t = marks.length ? marks.sort().at(-1)! : normTs(new Date(ctx.now()).toISOString());
  return { tasks, cursor: { t, k: [] } as Cursor };
}

interface Delta {
  tasks: ReturnType<typeof myTaskView>[];
  cursor: Cursor;
}

/** Changes after the cursor: tasks updated, and prompts posted on my tasks. */
async function changesSince(ctx: ToolContext, cursor: Cursor): Promise<Delta> {
  const mine = myTasksFilter(ctx);
  const [updated, prompts] = await Promise.all([
    must(ctx.db.select<Row>({
      table: 'agent_tasks',
      columns: TASK_FIELDS,
      filters: [mine, { col: 'updated_at', op: 'gte', value: cursor.t }],
      order: [{ column: 'updated_at', ascending: true }],
      limit: 100,
    })),
    must(ctx.db.select<Row>({
      table: 'agent_activities',
      columns: 'task_id,seq,body,created_at',
      filters: [{ col: 'type', op: 'eq', value: 'prompt' }, { col: 'created_at', op: 'gte', value: cursor.t }],
      order: [{ column: 'created_at', ascending: true }],
      limit: 100,
    })),
  ]);
  const seen = new Set(cursor.k);
  const items: { key: string; ts: string }[] = [];
  const fresh = (key: string, ts: string) => !(ts === cursor.t && seen.has(key)) && ts >= cursor.t;

  const tasks = new Map<string, Row>();
  for (const t of updated ?? []) {
    const ts = normTs(String(t.updated_at));
    const key = `t:${String(t.id)}:${ts}`;
    if (!fresh(key, ts)) continue;
    items.push({ key, ts });
    tasks.set(String(t.id), t);
  }
  const newPrompts = new Map<string, Row[]>();
  for (const a of prompts ?? []) {
    const ts = normTs(String(a.created_at));
    const key = `a:${String(a.task_id)}:${String(a.seq)}`;
    if (!fresh(key, ts)) continue;
    items.push({ key, ts });
    const list = newPrompts.get(String(a.task_id)) ?? [];
    list.push(a);
    newPrompts.set(String(a.task_id), list);
  }
  // Prompts can arrive on tasks whose row did not change: load those tasks (only mine pass the filter).
  const missing = [...newPrompts.keys()].filter((id) => !tasks.has(id));
  if (missing.length) {
    const extra = await must(ctx.db.select<Row>({
      table: 'agent_tasks',
      columns: TASK_FIELDS,
      filters: [mine, { col: 'id', op: 'in', value: missing }],
    }));
    for (const t of extra ?? []) tasks.set(String(t.id), t);
  }

  const out: ReturnType<typeof myTaskView>[] = [];
  for (const [id, task] of tasks) {
    const list = newPrompts.get(id) ?? [];
    const latest = list.length ? list.reduce((a, b) => (Number(b.seq) > Number(a.seq) ? b : a)) : undefined;
    const reason = reasonFor(task, latest);
    if (reason) out.push(myTaskView(task, reason, list.length));
  }

  let next = cursor;
  if (items.length) {
    const t = items.map((i) => i.ts).sort().at(-1)!;
    const atT = items.filter((i) => i.ts === t).map((i) => i.key);
    next = { t, k: t === cursor.t ? [...new Set([...cursor.k, ...atT])] : atT };
  }
  return { tasks: out, cursor: next };
}

const waitForMyTasks: ToolDef = {
  name: 'wait_for_my_tasks',
  title: 'Wait until any of my tasks needs me',
  description:
    'Without `after`: answers at once with your pending tasks and a cursor. With `after` (the next_cursor of the previous ' +
    'call): holds until a task assigned to you is queued, gets feedback, a new brief, an approval decision, a stop, or is ' +
    'closed; or until timeout_s (default 50, max 120). On changed:false call again with the same cursor.',
  inputSchema: object({
    after: { type: 'string' },
    timeout_s: { type: 'integer', minimum: 0, maximum: MAX_WAIT_S, default: DEFAULT_WAIT_S },
  }),
  outputSchema: output({
    changed: { type: 'boolean' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          title: { type: 'string' },
          state: { type: 'string' },
          review_state: { type: 'string' },
          waiting_on: { type: ['string', 'null'] },
          brief_version: { type: 'integer' },
          pending_prompts: { type: 'integer' },
          reason: { type: 'string', enum: ['queued', 'feedback', 'brief', 'approval_decided', 'stop', 'closed'] },
        },
      },
    },
    next_cursor: { type: 'string' },
  }),
  annotations: READ,
  cacheTtlMs: 0,
  budgetMs: (args) => timeoutOf(args) * 1000 + 15_000,
  async handler(args, ctx) {
    const after = str(args.after);
    if (!after) {
      const { tasks, cursor } = await initialState(ctx);
      if (tasks.length) await markDelivered(ctx);
      return {
        text: tasks.length ? `${plural(tasks.length, 'task')} need you.` : 'Nothing pending. Wait again with next_cursor.',
        structured: { changed: tasks.length > 0, tasks, next_cursor: encodeTaskCursor(cursor) },
      };
    }
    let cursor = decodeTaskCursor(after);
    const timeoutS = timeoutOf(args);
    const started = ctx.now();
    const deadline = started + timeoutS * 1000;
    let lastProgress = started;
    for (;;) {
      const delta = await changesSince(ctx, cursor);
      cursor = delta.cursor;
      if (delta.tasks.length) {
        await markDelivered(ctx);
        return {
          text: delta.tasks.map((t) => `${String(t.task_id)} ${t.reason} (${String(t.state)})`).join('; '),
          structured: { changed: true, tasks: delta.tasks, next_cursor: encodeTaskCursor(cursor) },
        };
      }
      if (ctx.now() >= deadline || !await nap(ctx, Math.min(POLL_MS, Math.max(0, deadline - ctx.now())))) break;
      if (ctx.now() - lastProgress >= PROGRESS_EVERY_MS) {
        lastProgress = ctx.now();
        ctx.progress(Math.round((lastProgress - started) / 1000), timeoutS, 'waiting for my tasks');
      }
    }
    return {
      text: 'No change. Call again with the same cursor.',
      structured: { changed: false, tasks: [], next_cursor: encodeTaskCursor(cursor) },
    };
  },
};

export const waitTools: ToolDef[] = [waitForTask, waitForMyTasks];
