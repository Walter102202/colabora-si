import assert from 'node:assert/strict';
import type { Db, Filter, SelectSpec } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { decodeTaskCursor, encodeTaskCursor, normTs, POLL_MS, waitTools } from './wait.ts';

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
  let clock = 1_000_000;
  let sleeps = 0;
  const db: Db = {
    rpc: (fn, params) => {
      rpcs.push({ fn, params });
      return Promise.resolve({ data: null, error: null });
    },
    select: <T>(spec: SelectSpec) => {
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
  return { ctx, rpcs, sleeps: () => sleeps, elapsed: () => clock - 1_000_000 };
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

Deno.test('wait_for_task without after_seq answers at once with next_seq', async () => {
  const h = harness({ agent_tasks: [task()], agent_activities: [activity(1), activity(2), activity(3)] });
  const out = await tool('wait_for_task').handler({ task_id: 't1', timeout_s: 120 }, h.ctx);
  assert.equal(out.structured.changed, false);
  assert.equal(out.structured.next_seq, 3);
  assert.deepEqual(out.structured.activities, []);
  assert.equal(h.sleeps(), 0);
});

Deno.test('wait_for_task: a state change between two polls returns changed before the timeout', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)], agent_runs: [] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 2) tables.agent_tasks[0] = task({ state: 'ready_for_review', review_state: 'pending' });
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 60 }, h.ctx);
  assert.equal(out.structured.changed, true);
  assert.equal((out.structured.task as Row).state, 'ready_for_review');
  assert.equal(h.sleeps(), 2);
  assert.ok(h.elapsed() < 60_000);
});

Deno.test('wait_for_task: a new activity after after_seq is returned with next_seq', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)] };
  const h = harness(tables, (n) => {
    if (n === 1) {
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
});

Deno.test('wait_for_task with run_id clears the wait when it returns, and reports a stop request', async () => {
  const tables = { agent_tasks: [task()], agent_activities: [activity(1)], agent_runs: [{ id: 'run-1', stop_requested_at: null, stop_acked_at: null }] as Row[] };
  const h = harness(tables, (n) => {
    if (n === 3) tables.agent_runs[0] = { id: 'run-1', stop_requested_at: '2026-10-27T10:05:00+00:00', stop_acked_at: null };
  });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 20, run_id: 'run-1' }, h.ctx);
  assert.equal(out.structured.changed, true);
  assert.equal(out.structured.stop_requested, true);
  assert.deepEqual(h.rpcs.map((r) => r.params.p_task_id), ['t1', null]);
});

Deno.test('wait_for_task times out with changed:false after timeout_s, polling every 1.5 s', async () => {
  const h = harness({ agent_tasks: [task()], agent_activities: [activity(1)] });
  const out = await tool('wait_for_task').handler({ task_id: 't1', after_seq: 1, timeout_s: 6 }, h.ctx);
  assert.equal(out.structured.changed, false);
  assert.equal(out.structured.next_seq, 1);
  assert.equal(h.elapsed(), 6000);
  assert.equal(h.sleeps(), 6000 / POLL_MS);
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
  };
  const after = encodeTaskCursor({ t: normTs('2026-10-27T10:00:00+00:00'), k: ['t:t1:' + normTs('2026-10-27T10:00:00+00:00')] });
  const h = harness(tables, (n) => {
    if (n === 1) {
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
