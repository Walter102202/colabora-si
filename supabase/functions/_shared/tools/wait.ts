// Waiting tools (§IV.9.7): hold the call until something changes or the timeout passes. An empty iteration costs one
// select on agent_events (backoff 1.5 s up to 10 s); a full snapshot runs on a fresh event, at least every SLOW_POLL_MS
// and at the deadline. Cursors are evaluated before sleeping, so nothing is lost between two calls.
import { type Filter, must, ToolError } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { num, object, output, plural, READ, str } from './common.ts';
import { markDelivered, myTasksFilter } from './tasks.ts';
import { answeredQuestions, excerpt, openQuestions, type Row } from './taskData.ts';

export const POLL_MS = 1500;
export const MAX_POLL_MS = 10_000;
export const BACKOFF_FACTOR = 1.5;
/** Longest gap between two full snapshots while nothing happens: the backoff nap is capped so it never crosses it. */
export const SLOW_POLL_MS = 10_000;
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
  if (typeof body.approval_id === 'string') out.approval_id = body.approval_id;
  if (typeof body.decision === 'string') {
    // An answer also carries the question it answers: its excerpt is what the person wrote, or the option chosen.
    const text = typeof body.text === 'string' ? body.text : '';
    out.decision = body.decision;
    out.text = text;
    out.excerpt = text ? excerpt({ text }) : body.decision;
  }
  return out;
}

interface EventMark { t: string; k: string[] }
/** Events addressed to the calling agent after the mark: one indexed select (agent_events_agent_idx). Humans get none. */
async function newEvents(ctx: ToolContext, mark: EventMark): Promise<{ fresh: Row[]; mark: EventMark }> {
  if (!ctx.principal.agentId) return { fresh: [], mark };
  const rows = await must(ctx.db.select<Row>({
    table: 'agent_events',
    columns: 'event_id,task_id,run_id,type,payload,created_at',
    filters: [{ col: 'agent_id', op: 'eq', value: ctx.principal.agentId }, { col: 'created_at', op: 'gte', value: mark.t }],
    order: [{ column: 'created_at', ascending: true }],
    limit: 100, // a cursor, not a cap: the mark moves to the last fresh row; only 100+ events sharing one created_at could stall
  })) ?? [];
  const seen = new Set(mark.k);
  const fresh = rows.filter((e) => { const ts = normTs(String(e.created_at)); return ts > mark.t || (ts === mark.t && !seen.has(`e:${String(e.event_id)}`)); });
  if (!fresh.length) return { fresh, mark };
  const t = fresh.map((e) => normTs(String(e.created_at))).sort().at(-1)!;
  const atT = fresh.filter((e) => normTs(String(e.created_at)) === t).map((e) => `e:${String(e.event_id)}`);
  return { fresh, mark: { t, k: t === mark.t ? [...new Set([...mark.k, ...atT])] : atT } };
}
/** Latest event timestamp for the agent, so a wait only reacts to events created after it started. */
async function latestEventMark(ctx: ToolContext): Promise<EventMark> {
  if (!ctx.principal.agentId) return { t: normTs(new Date(ctx.now()).toISOString()), k: [] };
  const rows = await must(ctx.db.select<Row>({ table: 'agent_events', columns: 'event_id,created_at', filters: [{ col: 'agent_id', op: 'eq', value: ctx.principal.agentId }], order: [{ column: 'created_at', ascending: false }], limit: 1 })) ?? [];
  const last = rows[0];
  return last ? { t: normTs(String(last.created_at)), k: [`e:${String(last.event_id)}`] } : { t: normTs(new Date(ctx.now()).toISOString()), k: [] };
}
const nextDelay = (ms: number) => Math.min(MAX_POLL_MS, Math.round(ms * BACKOFF_FACTOR));

const waitForTask: ToolDef = {
  name: 'wait_for_task',
  title: 'Wait until a task changes',
  description:
    'Holds the call until the task (or one of its direct subtasks) changes, a new activity arrives after after_seq, ' +
    'a stop is requested on run_id, or timeout_s passes (default 50, max 120). Without after_seq it answers at once with ' +
    'the current state, next_seq, the answers given since the last run ended (answered_questions) and the questions asked ' +
    'without blocking that still wait for one (open_questions). With run_id the wait counts as a heartbeat; timeout_s = 0 only registers the wait ' +
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
    answered_questions: { type: 'array', items: { type: 'object' } },
    open_questions: { type: 'array', items: { type: 'object' } },
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

    // Only a call that will wait needs the event mark. It comes before the baseline, so a change committed after it is
    // either in the baseline or brings a fresh event.
    const willWait = afterSeq !== undefined && timeoutS > 0;
    let mark: EventMark = willWait ? await latestEventMark(ctx) : { t: '', k: [] };
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

    if (afterSeq === undefined) {
      // The read a harness makes right after claim_task: it also brings the answers given since the last run ended and
      // the questions an earlier run left open, which this run now waits on.
      const out = finish(false);
      const [answered, open] = await Promise.all([answeredQuestions(ctx.db, taskId), openQuestions(ctx.db, taskId)]);
      return { ...out, structured: { ...out.structured, answered_questions: answered, open_questions: open } };
    }
    const isChanged = () => snap.activities.length > 0 || snap.stop || fingerprint(snap) !== baseline;

    if (runId) await must(ctx.db.rpc('touch_run_wait', { p_run_id: runId, p_task_id: taskId }));
    if (timeoutS === 0) return finish(isChanged());

    let delay = POLL_MS;
    let lastFull = ctx.now();
    let lastProgress = started;
    let snapped = false; // whether the current iteration took a full snapshot
    try {
      while (!isChanged() && ctx.now() < deadline) {
        snapped = false;
        if (!await nap(ctx, Math.min(delay, deadline - ctx.now(), Math.max(0, lastFull + SLOW_POLL_MS - ctx.now())))) break;
        if (ctx.now() - lastProgress >= PROGRESS_EVERY_MS) {
          lastProgress = ctx.now();
          ctx.progress(Math.round((lastProgress - started) / 1000), timeoutS, `waiting on task ${taskId}`);
        }
        const signal = await newEvents(ctx, mark);
        mark = signal.mark;
        if (signal.fresh.length || ctx.now() - lastFull >= SLOW_POLL_MS) {
          snap = await snapshotTask(ctx, taskId, afterSeq, runId);
          snapped = true;
          lastFull = ctx.now();
          delay = signal.fresh.length ? POLL_MS : nextDelay(delay);
        } else {
          delay = nextDelay(delay);
        }
      }
      // The last nap may end at the deadline right after a cheap poll: re-read once (unless this iteration already did),
      // so a change without an event is reported by this call instead of being absorbed by the next call's baseline.
      if (!snapped && !isChanged() && ctx.now() >= deadline) snap = await snapshotTask(ctx, taskId, afterSeq, runId);
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

export type Reason = 'handover' | 'queued' | 'feedback' | 'brief' | 'approval_decided' | 'stop' | 'closed' | 'under_review' | 'ready_for_review' | 'updated';

interface Cursor {
  /** High-water timestamp (normalized, microseconds, UTC). */
  t: string;
  /** Keys already delivered exactly at `t`. */
  k: string[];
  /** Independent event position: never skips a late task/prompt transaction. */
  e?: EventMark;
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
    if (typeof c?.t === 'string' && Array.isArray(c.k)) return { t: c.t, k: c.k.map(String),
      ...(typeof c.e?.t === 'string' && Array.isArray(c.e.k) ? { e: { t: c.e.t, k: c.e.k.map(String) } } : {}) };
  } catch {
    // fall through
  }
  throw new ToolError('invalid_input', 'The cursor is not valid. Call wait_for_my_tasks without `after` to get a new one.');
}

const TASK_FIELDS = 'id,title,state,review_state,waiting_on,brief_version,brief_stale,active_run_id,updated_at,depends_on_task_ids,request_kind';

/** Agents resolve dependencies under the same assignment boundary as claim_task, even across RLS-hidden pages. */
export async function openDependencies(ctx: ToolContext, tasks: Row[]): Promise<Map<string, string[]>> {
  if (ctx.principal.agentId) {
    if (!tasks.some(t => Array.isArray(t.depends_on_task_ids) && t.depends_on_task_ids.length)) return new Map(tasks.map(t => [String(t.id), []]));
    const result = await must(ctx.db.rpc<Record<string, string[]>>('open_dependencies', { p_task_ids: tasks.map(t => t.id) }));
    return new Map(Object.entries(result ?? {}));
  }
  // Human task lists retain their own RLS visibility; this RPC is only for agent claims.
  const dependencies = new Map(tasks.map((t) => [String(t.id), (t.depends_on_task_ids ?? []) as string[]]));
  const ids = [...new Set([...dependencies.values()].flat())];
  if (!ids.length) return new Map(tasks.map((t) => [String(t.id), []]));
  const rows = await must(ctx.db.select<Row>({
    table: 'agent_tasks', columns: 'id,state', filters: [{ col: 'id', op: 'in', value: ids }],
  })) ?? [];
  const done = new Set(rows.filter((r) => r.state === 'done').map((r) => String(r.id)));
  return new Map([...dependencies].map(([id, deps]) => [id, deps.filter((dep) => !done.has(dep))]));
}

export function reasonFor(task: Row, prompt: Row | undefined, waitsOnPerson = false): Reason | null {
  if (task.state === 'done' || task.state === 'failed') return 'closed';
  if (task.state === 'cancelled') return 'stop';
  const idle = task.state === 'input_required' && !task.active_run_id;
  // A message from the Lead does not move a task waiting without a run (send_agent_message keeps it there): what that
  // task waits for decides, below, so a handover that lands with the Lead's message is still a handover.
  if (prompt && !(idle && prompt.author_type === 'agent')) {
    const body = (prompt.body ?? {}) as Row;
    if (body.signal === 'stop') return 'stop';
    if (body.handover === true) return 'handover';
    // A decision with no run waiting for it was taken after a handover: the next session picks the task up. A task
    // under review is not handed over: a delivery cancels its open questions, so the agent has nothing to pick up.
    if (body.approval_id !== undefined || body.decision !== undefined) {
      if (task.active_run_id) return 'approval_decided';
      return task.state === 'ready_for_review' ? null : 'handover';
    }
    if (body.signal === 'feedback' || body.signal === 'continue') return 'feedback';
    if (body.signal === 'start' && task.state === 'queued') return 'queued';
  }
  // A handover leaves a task waiting on a person without a run: the next session claims it and waits there. A blocked or
  // escalated review leaves the same fields, but no session may take that task (claim_task refuses it): it is feedback
  // that waits on a person (waiting_on human), which harnesses leave to the person.
  if (idle) return waitsOnPerson ? 'feedback' : 'handover';
  if (task.brief_stale === true) return 'brief';
  if (task.state === 'queued') return 'queued';
  return null;
}

const LATEST_PAGE = 200;

/**
 * The newest `col` of `table` for each task id, exact: one page for every id, then, if the page came back full, one row
 * for each id the page may have cut off (an id with a row in the page already has its newest one there).
 */
async function latestPerTask(ctx: ToolContext, table: string, col: string, ids: string[], filters: Filter[]): Promise<Map<string, string>> {
  const select = (taskFilter: Filter, limit: number) => must(ctx.db.select<Row>({
    table,
    columns: `task_id,${col}`,
    filters: [taskFilter, ...filters],
    order: [{ column: col, ascending: false }],
    limit,
  }));
  const rows = (await select({ col: 'task_id', op: 'in', value: ids }, LATEST_PAGE)) ?? [];
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(String(r.task_id))) out.set(String(r.task_id), normTs(String(r[col])));
  if (rows.length < LATEST_PAGE) return out;
  const missing = ids.filter((id) => !out.has(id));
  const extra = await Promise.all(missing.map((id) => select({ col: 'task_id', op: 'eq', value: id }, 1)));
  extra.forEach((r, i) => { if (r?.[0]) out.set(missing[i], normTs(String(r[0][col]))); });
  return out;
}

/**
 * Of the tasks waiting without a run, those a blocked or escalated review left to a person: a review with that verdict
 * newer than the last run's start. A handover always follows a later claim, so its last run started after any review.
 */
async function waitingOnPerson(ctx: ToolContext, tasks: Row[]): Promise<Set<string>> {
  const ids = tasks.filter((t) => t.state === 'input_required' && !t.active_run_id).map((t) => String(t.id));
  if (!ids.length) return new Set();
  const [review, run] = await Promise.all([
    latestPerTask(ctx, 'agent_reviews', 'created_at', ids, [{ col: 'verdict', op: 'in', value: ['blocked', 'changes_requested'] }]),
    latestPerTask(ctx, 'agent_runs', 'started_at', ids, []),
  ]);
  return new Set(ids.filter((id) => review.has(id) && (!run.has(id) || review.get(id)! > run.get(id)!)));
}

async function lastSessions(ctx: ToolContext, ids: string[]): Promise<Map<string, string | null>> {
  const sessions = new Map<string, string | null>();
  if (!ids.length || !ctx.principal.agentId) return sessions;
  const select = (filter: Filter, limit: number) => must(ctx.db.select<Row>({
    table: 'agent_runs', columns: 'task_id,external_session_id,started_at',
    filters: [filter, { col: 'agent_id', op: 'eq', value: ctx.principal.agentId }],
    order: [{ column: 'started_at', ascending: false }], limit,
  }));
  const rows = await select({ col: 'task_id', op: 'in', value: ids }, LATEST_PAGE) ?? [];
  const add = (row: Row) => { if (!sessions.has(String(row.task_id))) sessions.set(String(row.task_id), typeof row.external_session_id === 'string' ? row.external_session_id : null); };
  rows.forEach(add);
  if (rows.length === LATEST_PAGE) {
    const extra = await Promise.all(ids.filter((id) => !sessions.has(id)).map((id) => select({ col: 'task_id', op: 'eq', value: id }, 1)));
    for (const page of extra) if (page?.[0]) add(page[0]);
  }
  return sessions;
}

function myTaskView(task: Row, reason: Reason, prompts: number, blockedBy: string[] = [], sessionId: string | null = null) {
  return {
    task_id: task.id,
    session_id: sessionId,
    title: task.title,
    state: task.state,
    review_state: task.review_state,
    waiting_on: task.waiting_on,
    brief_version: task.brief_version,
    active_run_id: task.active_run_id,
    pending_prompts: prompts,
    blocked_by: blockedBy,
    request_kind: task.request_kind ?? null,
    reason,
  };
}

/** Addressed Lead notices are data even when the parent row itself did not change. */
async function leadNotices(ctx: ToolContext, events: Row[]): Promise<ReturnType<typeof myTaskView>[]> {
  const notices = events.filter((event) => {
    const payload = event.payload as Row | null;
    return payload && ((event.type === 'task.continue' && typeof payload.review_of === 'string')
      || (event.type === 'task.updated' && (payload.environment_release || payload.verdict || payload.minor_findings || payload.review_timeout)));
  });
  if (!notices.length || !ctx.principal.agentId) return [];
  const parents = await must(ctx.db.select<Row>({ table:'agent_tasks',columns:TASK_FIELDS,
    filters:[myTasksFilter(ctx),{col:'id',op:'in',value:[...new Set(notices.map(event=>String(event.task_id)))]}] })) ?? [];
  const sessions = await lastSessions(ctx, parents.map(task=>String(task.id)));
  return notices.flatMap((event) => {
    const task = parents.find(parent=>parent.id===event.task_id);
    if (!task) return [];
    const payload=event.payload as Row;
    const reason: Reason=event.type==='task.continue' ? payload.review_task_id ? 'under_review' : 'ready_for_review' : 'updated';
    return [{ ...myTaskView(task,reason,0,[],sessions.get(String(task.id))??null), notice:{event_id:event.event_id,type:event.type,payload} }];
  });
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
  const [waiting, blocked] = await Promise.all([
    waitingOnPerson(ctx, open ?? []), openDependencies(ctx, open ?? []),
  ]);
  const tasks = (open ?? []).flatMap((t) => {
    // review_state outlives the round it describes: on a task waiting without a run, only the reviews and runs tell.
    const idle = t.state === 'input_required' && !t.active_run_id;
    const reason: Reason | null = t.review_state === 'changes_requested' && !idle
      ? 'feedback'
      : reasonFor(t, undefined, waiting.has(String(t.id)));
    const blockedBy = blocked.get(String(t.id)) ?? [];
    return reason && !(reason === 'queued' && blockedBy.length) ? [myTaskView(t, reason, 0, blockedBy)] : [];
  });
  const sessions = await lastSessions(ctx, tasks.map((task) => String(task.task_id)));
  for (const task of tasks) task.session_id = sessions.get(String(task.task_id)) ?? null;
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
      columns: 'task_id,seq,body,author_type,created_at',
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
  const [waiting, blocked] = await Promise.all([
    waitingOnPerson(ctx, [...tasks.values()]), openDependencies(ctx, [...tasks.values()]),
  ]);
  for (const [id, task] of tasks) {
    const list = newPrompts.get(id) ?? [];
    const latest = list.length ? list.reduce((a, b) => (Number(b.seq) > Number(a.seq) ? b : a)) : undefined;
    const reason = reasonFor(task, latest, waiting.has(id));
    const blockedBy = blocked.get(id) ?? [];
    if (reason && !(reason === 'queued' && blockedBy.length)) out.push(myTaskView(task, reason, list.length, blockedBy));
  }
  const sessions = await lastSessions(ctx, out.map((task) => String(task.task_id)));
  for (const task of out) task.session_id = sessions.get(String(task.task_id)) ?? null;

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
          session_id: { type: ['string', 'null'] },
          title: { type: 'string' },
          state: { type: 'string' },
          review_state: { type: 'string' },
          waiting_on: { type: ['string', 'null'] },
          brief_version: { type: 'integer' },
          pending_prompts: { type: 'integer' },
          notice: { type: 'object', description: 'An addressed review, verdict, minor-findings or environment-release event; payload carries the subject ids and data.' },
          reason: { type: 'string', enum: ['handover', 'queued', 'feedback', 'brief', 'approval_decided', 'stop', 'closed', 'under_review', 'ready_for_review', 'updated'] },
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
      const notices = await newEvents(ctx,{t:'1970-01-01T00:00:00.000000Z',k:[]});
      tasks.push(...await leadNotices(ctx,notices.fresh));
      if (notices.fresh.length) cursor.e=notices.mark;
      if (tasks.length) await markDelivered(ctx);
      return {
        text: tasks.length ? `${plural(tasks.length, 'task')} need you.` : 'Nothing pending. Wait again with next_cursor.',
        structured: { changed: tasks.length > 0, tasks, next_cursor: encodeTaskCursor(cursor) },
      };
    }
    let cursor = decodeTaskCursor(after);
    // Event and task positions advance independently, preserving late task/prompt commits.
    let mark: EventMark = cursor.e ?? { t: cursor.t, k: cursor.k };
    let delay = POLL_MS;
    let lastFull = -Infinity;
    const timeoutS = timeoutOf(args);
    const started = ctx.now();
    const deadline = started + timeoutS * 1000;
    let lastProgress = started;
    for (;;) {
      const signal = await newEvents(ctx, mark);
      mark = signal.mark;
      const full = lastFull === -Infinity || signal.fresh.length > 0 || ctx.now() - lastFull >= SLOW_POLL_MS;
      if (full) {
        const delta = await changesSince(ctx, cursor);
        cursor = { ...delta.cursor, ...(signal.fresh.length ? {e:signal.mark} : cursor.e ? {e:cursor.e} : {}) };
        delta.tasks.push(...await leadNotices(ctx,signal.fresh));
        lastFull = ctx.now();
        if (delta.tasks.length) {
          await markDelivered(ctx);
          return {
            text: delta.tasks.map((t) => `${String(t.task_id)} ${t.reason} (${String(t.state)})`).join('; '),
            structured: { changed: true, tasks: delta.tasks, next_cursor: encodeTaskCursor(cursor) },
          };
        }
        if (signal.fresh.length) delay = POLL_MS;
      }
      if (ctx.now() >= deadline || !await nap(ctx, Math.min(delay, Math.max(0, deadline - ctx.now()), Math.max(0, lastFull + SLOW_POLL_MS - ctx.now())))) break;
      delay = nextDelay(delay);
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
