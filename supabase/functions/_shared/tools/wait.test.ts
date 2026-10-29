import { reasonFor } from './wait.ts';
import assert from 'node:assert/strict';
import type { Db, Filter, SelectSpec } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { decodeTaskCursor, encodeTaskCursor, normTs, SLOW_POLL_MS, waitTools } from './wait.ts';

type Row = Record<string, unknown>;

const tool = (name: string) => waitTools.find((t) => t.name === name) as ToolDef;

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col];
  switch (f.op) {
    case 'eq': return v === f.value;
    case 'neq': return v !== f.value;
    case 'gt': return (v as number | string) > (f.value as number | string);
    case 'gte': return normTs(String(v)) >= normTs(String(f.value));
    case 'lt': return (v as number | string) < (f.value as number | string);
    case 'in': return (f.value as unknown[]).includes(v);
    case 'is': return v === f.value || (f.value === null && v === undefined);
  }
}

/** In-memory tables; `onSleep` mutates them to simulate changes between two polls. */
function harness(tables: Record<string, Row[]>, onSleep: (n: number) => void = () => {}) {
  const rpcs: { fn: string; params: Record<string, unknown> }[] = [];
  const selects: string[] = [];
  const selectAt: { table: string; at: number }[] = [];
  let clock = 1_000_000;
  let sleeps = 0;
  const db: Db = {
    rpc: (fn, params) => {
      rpcs.push({ fn, params });
      return Promise.resolve({ data: null, error: null });
    },
    select: <T>(spec: SelectSpec) => {
      selects.push(spec.table);
      selectAt.push({ table: spec.table, at: clock - 1_000_000 });
      let rows = (tables[spec.table] ?? []).filter((r) => (spec.filters ?? []).every((f) => matches(r, f)));
      for (const o of [...(spec.order ?? [])].reverse()) {
        rows = [...rows].sort((a, b) => {
          const x = a[o.column] as number | string, y = b[o.column] as number | string;
          const cmp = x < y ? -1 : x > y ? 1 : 0;
          return o.ascending === false ? -cmp : cmp;
        });
      }
      if (spec.limit !== undefined) rows = rows.slice(0, spec.limit);
      return Promise.resolve({ data: rows.map((r) => ({ ...r })) as T[], error: null });
    },
  };
  const ctx: ToolContext = {
    db,
    principal: { type: 'agent', userId: 'u-agent', agentId: 'agent-1', workspaceId: 'w1', clientId: null },
    signal: new AbortController().signal,
    appUrl: '',
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      onSleep(++sleeps);
      return Promise.resolve();
    },
    progress: () => {},
  };
  return { ctx, rpcs, selects, selectAt, sleeps: () => sleeps, elapsed: () => clock - 1_000_000 };
}

function task(overrides: Row = {}): Row {
  return {
    id: 't1', title: 'Clean leads', state: 'working', review_state: 'none', waiting_on: null, brief_version: 1,
    brief_stale: false, review_rounds: 0, active_run_id: 'run-1', parent_task_id: null, delegate_agent_id: 'agent-1',
    owner_user_id: 'u-owner', created_at: '2026-10-27T10:00:00+00:00', updated_at: '2026-10-27T10:00:00.000100+00:00',
    ...overrides,
  };
}

function activity(seq: number, overrides: Row = {}): Row {
  return {
    id: `act-${seq}`, task_id: 't1', seq, type: 'action', author_type: 'agent', author_id: 'u-agent', ephemeral: false,
    body: { op: 'append_blocks', summary: `step ${seq}` }, created_at: `2026-10-27T10:00:0${seq}+00:00`, ...overrides,
  };
}

function event(id: string, createdAt: string, overrides: Row = {}): Row {
  return { event_id: id, agent_id: 'agent-1', task_id: 't1', run_id: null, type: 'task.feedback', payload: {}, seq: 1, created_at: createdAt, ...overrides };
}

Deno.test('wait_for_task without after_seq answers at once with next_seq', async () => {
  const h = harness({ agent_tasks: [task()], agent_activities: [activity(1), activity(2), activity(3)] });
  const out = await tool('wait_for_task').handler({ task_id: 't1', timeout_s: 120 }, h.ctx);
  assert.equal(out.structured.changed, false);
  assert.equal(out.structured.next_seq, 3);
  assert.deepEqual(out.structured.activities, []);
  assert.equal(h.sleeps(), 0);
  assert.equal(h.selects.filter((t) => t === 'agent_events').length, 0, 'no event mark on a call that does not wait');
});

Deno.test('wait_for_task: a state change between two polls returns changed before the timeout', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)], agent_runs: [] as Row[], agent_events: [] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 2) {
      tables.agent_tasks[0] = task({ state: 'ready_for_review', review_state: 'pending' });
      tables.agent_events.push(event('e1', '2026-10-27T10:00:05+00:00'));
    }
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 60 }, h.ctx);
  assert.equal(out.structured.changed, true);
  assert.equal((out.structured.task as Row).state, 'ready_for_review');
  assert.equal(h.sleeps(), 2);
  assert.ok(h.elapsed() < 60_000);
});

Deno.test('wait_for_task: a new activity after after_seq is returned with next_seq', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)], agent_events: [] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 1) {
      tables.agent_events.push(event('e2', '2026-10-27T10:00:02+00:00'));
      tables.agent_activities.push(activity(2, { type: 'prompt', author_type: 'agent', body: { text: 'Fix row 4', signal: 'feedback', source: 'lead' } }));
    }
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 30 }, h.ctx);
  assert.equal(out.structured.changed, true);
  const acts = out.structured.activities as Row[];
  assert.equal(acts.length, 1);
  assert.equal(acts[0].signal, 'feedback');
  assert.equal(acts[0].excerpt, 'Fix row 4');
  assert.equal(out.structured.next_seq, 2);
});

Deno.test('wait_for_task with timeout_s = 0 registers the wait with touch_run_wait and returns changed:false', async () => {
  const h = harness({ agent_tasks: [task()], agent_activities: [activity(1)], agent_runs: [{ id: 'lead-run', stop_requested_at: null, stop_acked_at: null }] });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 0, run_id: 'lead-run' }, h.ctx);
  assert.equal(out.structured.changed, false);
  assert.deepEqual(h.rpcs, [{ fn: 'touch_run_wait', params: { p_run_id: 'lead-run', p_task_id: 't1' } }]);
  assert.equal(h.sleeps(), 0);
  assert.equal(h.selects.filter((t) => t === 'agent_events').length, 0, 'no event mark on a call that does not wait');
});

Deno.test('wait_for_task with run_id clears the wait when it returns, and reports a stop request', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)], agent_runs: [{ id: 'run-1', stop_requested_at: null, stop_acked_at: null }] as Row[], agent_events: [] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 3) {
      tables.agent_runs[0] = { id: 'run-1', stop_requested_at: '2026-10-27T10:05:00+00:00', stop_acked_at: null };
      tables.agent_events.push(event('e3', '2026-10-27T10:05:00+00:00', { type: 'task.stop' }));
    }
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 20, run_id: 'run-1' }, h.ctx);
  assert.equal(out.structured.changed, true);
  assert.equal(out.structured.stop_requested, true);
  assert.deepEqual(h.rpcs.map((r) => r.params.p_task_id), ['t1', null]);
});

Deno.test('wait_for_task times out with changed:false, backing off 1.5 s, 2.25 s and the remainder', async () => {
  const h = harness({ agent_tasks: [task()], agent_activities: [activity(1)] });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 6 }, h.ctx);
  assert.equal(out.structured.changed, false);
  assert.equal(out.structured.next_seq, 1);
  assert.equal(h.elapsed(), 6000);
  assert.equal(h.sleeps(), 3);
});

Deno.test('wait_for_my_tasks without after answers at once with pending tasks and a cursor', async () => {
  const h = harness({
    agent_tasks: [
      task({ id: 'q1', state: 'queued', active_run_id: null, updated_at: '2026-10-27T09:00:00+00:00' }),
      task({ id: 'f1', state: 'ready_for_review', review_state: 'changes_requested', updated_at: '2026-10-27T09:30:00+00:00' }),
      task({ id: 'w1', state: 'working', updated_at: '2026-10-27T09:45:00+00:00' }),
      task({ id: 'other', state: 'queued', delegate_agent_id: 'agent-2' }),
    ],
    agent_activities: [],
  });
  const out = await tool('wait_for_my_tasks').handler({ timeout_s: 120 }, h.ctx);
  assert.equal(out.structured.changed, true);
  assert.deepEqual((out.structured.tasks as Row[]).map((t) => [t.task_id, t.reason]), [['q1', 'queued'], ['f1', 'feedback']]);
  assert.equal(decodeTaskCursor(String(out.structured.next_cursor)).t, normTs('2026-10-27T09:45:00+00:00'));
  assert.equal(h.sleeps(), 0);
});

Deno.test('wait_for_my_tasks with after returns only tasks updated after the cursor, with a reason', async () => {
  const tables = {
    agent_tasks: [
      task({ id: 'old', state: 'queued', updated_at: '2026-10-27T09:00:00+00:00' }),
      task({ id: 't1', state: 'ready_for_review', updated_at: '2026-10-27T10:00:00+00:00' }),
    ],
    agent_activities: [] as Row[],
    agent_events: [] as Row[],
  };
  const after = encodeTaskCursor({ t: normTs('2026-10-27T10:00:00+00:00'), k: ['t:t1:' + normTs('2026-10-27T10:00:00+00:00')] });
  const h = harness(tables, (n) => {
    if (n === 1) {
      tables.agent_events.push(event('e5', '2026-10-27T10:01:00.123456+00:00'));
      tables.agent_tasks[1] = task({ id: 't1', state: 'ready_for_review', review_state: 'changes_requested', updated_at: '2026-10-27T10:01:00.123456+00:00' });
      tables.agent_activities.push(activity(5, {
        type: 'prompt', author_type: 'agent', created_at: '2026-10-27T10:01:00.123456+00:00',
        body: { text: 'Row 4 duplicated', signal: 'feedback', source: 'lead' },
      }));
    }
  });
  const out = await tool('wait_for_my_tasks').handler({ after, timeout_s: 60 }, h.ctx);
  assert.equal(out.structured.changed, true);
  const tasks = out.structured.tasks as Row[];
  assert.deepEqual(tasks.map((t) => [t.task_id, t.reason, t.pending_prompts]), [['t1', 'feedback', 1]]);
  assert.deepEqual(h.rpcs.map((r) => r.fn), ['mark_events_delivered']);
  const next = decodeTaskCursor(String(out.structured.next_cursor));
  assert.equal(next.t, '2026-10-27T10:01:00.123456Z');

  // The same cursor again sees nothing new and times out unchanged.
  const again = await tool('wait_for_my_tasks').handler({ after: out.structured.next_cursor, timeout_s: 3 }, h.ctx);
  assert.equal(again.structured.changed, false);
  assert.equal(again.structured.next_cursor, out.structured.next_cursor);
});

Deno.test('wait_for_my_tasks timeout returns changed:false and the same cursor', async () => {
  const h = harness({ agent_tasks: [task({ updated_at: '2026-10-27T09:00:00+00:00' })], agent_activities: [] });
  const after = encodeTaskCursor({ t: normTs('2026-10-27T10:00:00+00:00'), k: [] });
  const out = await tool('wait_for_my_tasks').handler({ after, timeout_s: 3 }, h.ctx);
  assert.equal(out.structured.changed, false);
  assert.equal(out.structured.next_cursor, after);
  assert.equal(h.elapsed(), 3000);
  assert.deepEqual(h.rpcs, []);
});

Deno.test('wait_for_my_tasks reports a stop, an approval decision and a closed task', async () => {
  const t0 = '2026-10-27T10:00:00+00:00';
  const tables = {
    agent_tasks: [
      task({ id: 's1', updated_at: t0 }),
      task({ id: 'a1', updated_at: t0 }),
      task({ id: 'd1', state: 'done', updated_at: '2026-10-27T10:02:00+00:00' }),
    ],
    agent_activities: [
      activity(1, { task_id: 's1', type: 'prompt', created_at: '2026-10-27T10:01:00+00:00', body: { text: 'Stop', signal: 'stop' } }),
      activity(2, { task_id: 'a1', type: 'prompt', created_at: '2026-10-27T10:01:30+00:00', body: { signal: 'feedback', source: 'row_panel', approval_id: 'ap1', decision: 'approve' } }),
    ],
  };
  const h = harness(tables);
  const out = await tool('wait_for_my_tasks').handler({ after: encodeTaskCursor({ t: normTs('2026-10-27T10:00:30+00:00'), k: [] }) }, h.ctx);
  const reasons = Object.fromEntries((out.structured.tasks as Row[]).map((t) => [t.task_id, t.reason]));
  assert.deepEqual(reasons, { s1: 'stop', a1: 'approval_decided', d1: 'closed' });
});

Deno.test('wait_for_task without events runs one cheap select per poll and a full snapshot every 10 s', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)], agent_events: [] as Row[] };
  const h = harness(tables, (n) => {
    if (h.elapsed() >= 11_000 && tables.agent_tasks[0].state === 'working') tables.agent_tasks[0] = task({ state: 'ready_for_review' });
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 120 }, h.ctx);
  assert.equal(out.structured.changed, true);
  assert.ok(h.elapsed() >= 10_000 && h.elapsed() < 40_000, `elapsed ${h.elapsed()}`);
  const taskSelects = h.selects.filter((t) => t === 'agent_tasks').length;
  assert.ok(taskSelects <= 6, `full snapshots: ${taskSelects}`); // baseline (2) + slow polls (2 each), never one per poll
  assert.ok(h.selects.filter((t) => t === 'agent_events').length >= 4); // 1.5 + 2.25 + 3.4 s, then the nap is cut at 10 s: four cheap polls before the slow pass
});

Deno.test('wait_for_my_tasks: an event resets the backoff and triggers one full snapshot', async () => {
  const t0 = '2026-10-27T10:00:00+00:00';
  const tables = { agent_tasks: [task({ id: 'p1', updated_at: t0 })], agent_activities: [] as Row[], agent_events: [] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 3) { // at 7.1 s, before the 10 s slow pass: the full snapshot that follows is due to the event alone
      tables.agent_events.push(event('e9', '2026-10-27T10:00:20+00:00', { task_id: 'p1', type: 'task.updated', payload: { subtask_id: 's1', acceptance: 'accepted' } }));
      tables.agent_activities.push(activity(7, { task_id: 'p1', type: 'prompt', created_at: '2026-10-27T10:00:20+00:00', body: { text: 'Subtask "Report" closed by a person: accepted', signal: 'feedback', source: 'row_panel', subtask_id: 's1' } }));
    }
  });
  const after = encodeTaskCursor({ t: normTs('2026-10-27T10:00:01+00:00'), k: [] });
  const out = await tool('wait_for_my_tasks').handler({ after, timeout_s: 120 }, h.ctx);
  assert.equal(out.structured.changed, true);
  assert.deepEqual((out.structured.tasks as Row[]).map((t) => [t.task_id, t.reason]), [['p1', 'feedback']]);
  assert.equal(h.sleeps(), 3);
  assert.equal(h.selects.filter((t) => t === 'agent_tasks').length, 3); // first pass (updated) + the pass after the event (updated + the missing task): never one per poll
  assert.ok(!decodeTaskCursor(String(out.structured.next_cursor)).k.some((k) => k.startsWith('e:')), 'the cursor carries task and prompt keys only');
});

Deno.test('wait_for_my_tasks for a person (no agent id) never queries agent_events and keeps the slow poll', async () => {
  const tables = { agent_tasks: [task({ owner_user_id: 'u-h', delegate_agent_id: 'agent-9', updated_at: '2026-10-27T10:00:00+00:00' })], agent_activities: [] as Row[], agent_events: [] as Row[] };
  const h = harness(tables);
  h.ctx.principal = { type: 'human', userId: 'u-h', agentId: null, workspaceId: 'w1', clientId: null };
  const after = encodeTaskCursor({ t: normTs('2026-10-27T10:00:01+00:00'), k: [] });
  const out = await tool('wait_for_my_tasks').handler({ after, timeout_s: 20 }, h.ctx);
  assert.equal(out.structured.changed, false);
  assert.equal(h.selects.filter((t) => t === 'agent_events').length, 0);
  assert.ok(h.selects.filter((t) => t === 'agent_tasks').length >= 2); // first pass and the slow poll at 10 s
});

/** Timestamps (ms since start) of the full snapshots: one per distinct time an agent_tasks select ran. */
const snapshotTimes = (h: ReturnType<typeof harness>) => [...new Set(h.selectAt.filter((s) => s.table === 'agent_tasks').map((s) => s.at))];

Deno.test('wait_for_task: full snapshots are never more than SLOW_POLL_MS apart while nothing happens', async () => {
  const h = harness({ agent_tasks: [task()], agent_activities: [activity(1)], agent_events: [] as Row[] });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 60 }, h.ctx);
  assert.equal(out.structured.changed, false);
  const at = snapshotTimes(h);
  assert.ok(at.length >= 6, `snapshots at ${at.join(', ')}`);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] <= SLOW_POLL_MS, `${at[i] - at[i - 1]} ms between the snapshots at ${at[i - 1]} and ${at[i]}`);
  const selectsAt = (ms: number) => h.selectAt.filter((s) => s.table === 'agent_tasks' && s.at === ms).length;
  assert.equal(selectsAt(60_000), selectsAt(10_000), 'the deadline does not add a second snapshot when the slow poll already took one');
});

Deno.test('wait_for_task with a short timeout re-reads the task at the deadline, so a change without an event is reported by this call', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)], agent_events: [] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 2) tables.agent_tasks[0] = task({ state: 'ready_for_review', review_state: 'pending' }); // no event: only a snapshot can see it
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 6 }, h.ctx);
  assert.equal(out.structured.changed, true);
  assert.equal((out.structured.task as Row).state, 'ready_for_review');
  assert.equal(h.elapsed(), 6000);
});

Deno.test('wait_for_my_tasks: an event for a task that is not mine triggers a full pass but does not move the cursor', async () => {
  const tables = { agent_tasks: [task({ id: 'p1', updated_at: '2026-10-27T10:00:00+00:00' })], agent_activities: [] as Row[], agent_events: [] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 1) tables.agent_events.push(event('e7', '2026-10-27T10:00:30+00:00', { task_id: 'other-task', type: 'task.start' }));
  });
  const after = encodeTaskCursor({ t: normTs('2026-10-27T10:00:01+00:00'), k: [] });
  const out = await tool('wait_for_my_tasks').handler({ after, timeout_s: 5 }, h.ctx);
  assert.equal(out.structured.changed, false);
  assert.deepEqual(decodeTaskCursor(String(out.structured.next_cursor)), decodeTaskCursor(after));
  assert.equal(h.selects.filter((t) => t === 'agent_tasks').length, 2); // the first pass and the one the event triggered; nothing at the deadline
});

Deno.test('wait_for_my_tasks: full passes are never more than SLOW_POLL_MS apart while nothing happens', async () => {
  const h = harness({ agent_tasks: [task({ updated_at: '2026-10-27T10:00:00+00:00' })], agent_activities: [] as Row[], agent_events: [] as Row[] });
  const after = encodeTaskCursor({ t: normTs('2026-10-27T10:00:01+00:00'), k: [] });
  const out = await tool('wait_for_my_tasks').handler({ after, timeout_s: 60 }, h.ctx);
  assert.equal(out.structured.changed, false);
  const at = snapshotTimes(h);
  assert.ok(at.length >= 6, `passes at ${at.join(', ')}`);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] <= SLOW_POLL_MS, `${at[i] - at[i - 1]} ms between the passes at ${at[i - 1]} and ${at[i]}`);
});

Deno.test('reasonFor maps a handover prompt to handover', () => {
  assert.equal(reasonFor({ state: 'queued' }, { body: { signal: 'continue', handover: true } }), 'handover');
});

Deno.test('reasonFor: a handed-over task that waits on a person, or whose approval was decided without a run, is a handover', () => {
  assert.equal(reasonFor({ state: 'input_required', waiting_on: 'human', active_run_id: null }, undefined), 'handover');
  assert.equal(reasonFor({ state: 'input_required', waiting_on: 'human', active_run_id: 'run-1' }, undefined), null);
  const decided = { body: { signal: 'feedback', source: 'row_panel', approval_id: 'ap1', decision: 'approve' } };
  assert.equal(reasonFor({ state: 'queued', active_run_id: null }, decided), 'handover');
  assert.equal(reasonFor({ state: 'working', active_run_id: 'run-1' }, decided), 'approval_decided');
});

Deno.test('reasonFor: an answer given while the task is under review does not wake its agent', () => {
  const answer = { body: { signal: 'feedback', source: 'row_panel', approval_id: 'q1', decision: 'respond', text: 'Yes' } };
  assert.equal(reasonFor({ state: 'ready_for_review', active_run_id: null, brief_stale: false }, answer), null);
});

Deno.test('wait_for_my_tasks without after lists a handed-over task that waits on a person', async () => {
  const h = harness({
    agent_tasks: [
      task({ id: 'h1', state: 'input_required', waiting_on: 'human', active_run_id: null, updated_at: '2026-10-27T09:00:00+00:00' }),
      task({ id: 'w1', state: 'input_required', waiting_on: 'human', updated_at: '2026-10-27T09:30:00+00:00' }),
    ],
    agent_activities: [],
  });
  const out = await tool('wait_for_my_tasks').handler({ timeout_s: 120 }, h.ctx);
  assert.deepEqual((out.structured.tasks as Row[]).map((t) => [t.task_id, t.reason, t.waiting_on]), [['h1', 'handover', 'human']]);
});

Deno.test('wait_for_task hands over the approval_id and decision of an answer', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)], agent_events: [] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 1) {
      tables.agent_events.push(event('e2', '2026-10-27T10:00:02+00:00'));
      tables.agent_activities.push(activity(2, { type: 'prompt', author_type: 'human',
        body: { text: 'Casual', signal: 'feedback', source: 'row_panel', approval_id: 'q1', decision: 'respond', blocking: false } }));
    }
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 30 }, h.ctx);
  const acts = out.structured.activities as Row[];
  assert.equal(acts.length, 1);
  assert.equal(acts[0].approval_id, 'q1');
  assert.equal(acts[0].decision, 'respond');
  assert.equal(acts[0].text, 'Casual');
  assert.equal(acts[0].excerpt, 'Casual');
});

Deno.test('wait_for_task: an answer without text shows the option chosen, never the question it answers', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)], agent_events: [] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 1) {
      tables.agent_events.push(event('e2', '2026-10-27T10:00:02+00:00'));
      tables.agent_activities.push(activity(2, { type: 'prompt', author_type: 'human',
        body: { text: '', signal: 'feedback', source: 'row_panel', approval_id: 'q1', decision: 'ignore', blocking: true, question: 'Add a P.S.?' } }));
    }
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 30 }, h.ctx);
  const [answer] = out.structured.activities as Row[];
  assert.equal(answer.excerpt, 'ignore');
  assert.equal(answer.text, '');
  assert.equal(answer.decision, 'ignore');
});

Deno.test('wait_for_task without after_seq brings the answers given since the last run ended and the questions still open', async () => {
  const h = harness({
    agent_tasks: [task()],
    agent_activities: [activity(1)],
    agent_runs: [
      { id: 'run-0', task_id: 't1', status: 'completed', ended_at: '2026-10-27T09:00:00+00:00' },
      { id: 'run-1', task_id: 't1', status: 'running', ended_at: null },
    ],
    agent_approvals: [
      { id: 'q-late', task_id: 't1', kind: 'elicitation', blocking: false, status: 'decided', question: 'Add a P.S.?', decision: 'respond', response: { text: 'Yes, a short one' }, decided_at: '2026-10-27T09:30:00+00:00', created_at: '2026-10-27T08:10:00+00:00' },
      { id: 'q-seen', task_id: 't1', kind: 'elicitation', blocking: false, status: 'decided', question: 'Formal or casual?', decision: 'respond', response: { text: 'Casual' }, decided_at: '2026-10-27T08:30:00+00:00', created_at: '2026-10-27T08:00:00+00:00' },
      // Made blocking by await_questions before the run handed over, answered afterwards.
      { id: 'q-awaited', task_id: 't1', kind: 'elicitation', blocking: true, status: 'decided', question: 'Which list?', decision: 'respond', response: { text: 'October' }, decided_at: '2026-10-27T09:35:00+00:00', created_at: '2026-10-27T08:20:00+00:00' },
      { id: 'q-open', task_id: 't1', kind: 'elicitation', blocking: false, status: 'pending', question: 'Any image?', decision: null, response: null, decided_at: null, created_at: '2026-10-27T08:40:00+00:00' },
      { id: 'gate', task_id: 't1', kind: 'action', blocking: true, status: 'decided', question: 'Send it?', decision: 'approve', response: null, decided_at: '2026-10-27T09:40:00+00:00', created_at: '2026-10-27T08:50:00+00:00' },
      { id: 'gate-open', task_id: 't1', kind: 'action', blocking: true, status: 'pending', question: 'Publish it?', decision: null, response: null, decided_at: null, created_at: '2026-10-27T08:55:00+00:00' },
    ],
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', run_id: 'run-1' }, h.ctx);
  assert.deepEqual(out.structured.answered_questions, [
    { approval_id: 'q-late', question: 'Add a P.S.?', decision: 'respond', text: 'Yes, a short one', answered_at: '2026-10-27T09:30:00+00:00' },
    { approval_id: 'q-awaited', question: 'Which list?', decision: 'respond', text: 'October', answered_at: '2026-10-27T09:35:00+00:00' },
  ]);
  assert.deepEqual(out.structured.open_questions, [
    { approval_id: 'q-open', question: 'Any image?', asked_at: '2026-10-27T08:40:00+00:00' },
  ]);
  assert.equal(h.selects.filter((t) => t === 'agent_events').length, 0, 'still no event mark on a call that does not wait');
});
