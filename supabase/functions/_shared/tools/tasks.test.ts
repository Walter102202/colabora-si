import assert from 'node:assert/strict';
import { type Db, type DbError, type DbResult, type Filter, type SelectSpec, ToolError } from '../db.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { taskTools } from './tasks.ts';

type Row = Record<string, unknown>;

const tool = (name: string) => taskTools.find((t) => t.name === name) as ToolDef;

function ctxWith(rpc: (fn: string, args: Row) => Promise<DbResult<unknown>>): ToolContext {
  const db: Db = { rpc: <T>(fn: string, args: Row) => rpc(fn, args) as Promise<DbResult<T>>, select: () => Promise.resolve({ data: [], error: null }) };
  return {
    db,
    principal: { type: 'agent', userId: 'u-agent', agentId: 'agent-1', workspaceId: 'w1', clientId: null },
    signal: new AbortController().signal,
    appUrl: '',
    now: () => 0,
    sleep: () => Promise.resolve(),
    progress: () => {},
  };
}

Deno.test('claim_task does not promise to reopen done tasks', () => {
  assert.doesNotMatch(tool('claim_task').description, /reopens it with a new run/);
  assert.match(tool('claim_task').description, /only a person reopens it/);
});

Deno.test('claim_task surfaces task_unavailable as a ToolError the model can act on', async () => {
  const ctx = ctxWith(() => Promise.resolve({ data: null, error: { code: 'PT409', message: 'task_unavailable' } }));
  await assert.rejects(
    () => tool('claim_task').handler({ task_id: 't1', harness: 'codex' }, ctx),
    (err: unknown) => err instanceof ToolError && err.code === 'task_unavailable'
      && err.message === 'The task cannot be claimed in its current state.',
  );
});

Deno.test('submit_for_review says that a delivery waits for the last blocking answer, and which requests block', async () => {
  const ctx = ctxWith(() => Promise.resolve({ data: null, error: { code: 'PT409', message: 'waiting_on_human', details: '{"approval_ids":["q2"]}' } }));
  await assert.rejects(
    () => tool('submit_for_review').handler({ run_id: 'run-1', summary: 'Done', artifact_ids: ['art-1'] }, ctx),
    (err: unknown) => err instanceof ToolError && err.code === 'waiting_on_human' && /still has to answer/.test(err.message)
      && JSON.stringify(err.detail) === '{"approval_ids":["q2"]}',
  );
  assert.match(tool('submit_for_review').description, /waiting_on_human/);
  assert.match(tool('await_questions').description, /delivery waits/);
});

// ---------------------------------------------------------------------------
// get_task over in-memory tables (the same fake card.test.ts uses).
// ---------------------------------------------------------------------------

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col];
  switch (f.op) {
    case 'eq': return v === f.value;
    case 'neq': return v !== f.value;
    case 'gt': return (v as number | string) > (f.value as number | string);
    case 'gte': return (v as number | string) >= (f.value as number | string);
    case 'lt': return (v as number | string) < (f.value as number | string);
    case 'in': return (f.value as unknown[]).includes(v);
    case 'is': return v === f.value || (f.value === null && v === undefined);
  }
}

interface RpcCall {
  fn: string;
  params: Record<string, unknown>;
}

/** In-memory tables; `onRpc` answers (or fails) the control RPCs and may mutate the tables like the database would. */
function harness(
  tables: Record<string, Row[]>,
  opts: { principal?: ToolContext['principal']; onRpc?: (call: RpcCall) => { data?: Row; error?: DbError } | void } = {},
) {
  const rpcs: RpcCall[] = [];
  const db: Db = {
    rpc: <T>(fn: string, params: Record<string, unknown>): Promise<DbResult<T>> => {
      const call = { fn, params };
      rpcs.push(call);
      const out = opts.onRpc?.(call) ?? {};
      if (out.error) return Promise.resolve({ data: null, error: out.error });
      return Promise.resolve({ data: (out.data ?? null) as T | null, error: null });
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
    principal: opts.principal ?? { type: 'human', userId: 'u-owner', agentId: null, workspaceId: 'w1', clientId: null },
    signal: new AbortController().signal,
    appUrl: 'https://app.example',
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    progress: () => {},
  };
  return { ctx, rpcs, tables };
}

function task(overrides: Row = {}): Row {
  return {
    id: 't1', workspace_id: 'w1', context_id: 'c1', db_page_id: 'db1', row_page_id: 'row1', title: 'Clean leads',
    delegate_agent_id: 'agent-1', owner_user_id: 'u-owner', parent_task_id: null, depends_on_task_ids: [], state: 'ready_for_review',
    review_state: 'changes_requested', acceptance: 'pending', waiting_on: null, brief_version: 2, brief_stale: false, active_run_id: 'run-1',
    review_rounds: 1, max_review_rounds: 2, cost_usd: 0.01, last_activity_at: '2026-10-27T10:05:00+00:00',
    created_at: '2026-10-27T10:00:00+00:00', updated_at: '2026-10-27T10:05:00+00:00', closed_at: null, closed_by: null,
    ...overrides,
  };
}

function approval(overrides: Row = {}): Row {
  return {
    id: 'ap1', task_id: 't1', run_id: 'run-1', kind: 'action', action: 'send_email', params: { to: 'ops@example.com' }, artifact_id: null,
    artifact_version: 2, question: 'Send it?', options: ['approve', 'reject'], status: 'pending', decision: null, response: null,
    decided_by: null, decided_at: null, expires_at: '2026-10-28T10:00:00+00:00', created_at: '2026-10-27T10:04:00+00:00', ...overrides,
  };
}

function world(): Record<string, Row[]> {
  return {
    agent_tasks: [
      task(),
      task({ id: 'sub1', title: 'Check tags', parent_task_id: 't1', delegate_agent_id: 'agent-2', state: 'working', active_run_id: 'run-2', created_at: '2026-10-27T10:02:00+00:00' }),
    ],
    task_briefs: [{ task_id: 't1', version: 2, objective: 'Dedupe', constraints: '', done_when: [{ id: 'c1', text: 'No duplicates', check: 'human' }], decisions: [], sources: [], open_questions: [], next_step: '', policies: {}, author_type: 'human', created_at: '2026-10-27T10:00:00+00:00' }],
    agent_artifacts: [
      { id: 'art1', task_id: 't1', run_id: 'run-1', kind: 'page', ref: 'p9', version: 1, title: 'Summary', satisfies: ['c1'], author_type: 'agent', author_id: 'u-agent', superseded_by: null, created_at: '2026-10-27T10:03:00+00:00' },
      { id: 'art2', task_id: 't1', run_id: 'run-1', kind: 'page', ref: 'p9', version: 2, title: 'Summary', satisfies: ['c1'], author_type: 'agent', author_id: 'u-agent', superseded_by: null, created_at: '2026-10-27T10:04:30+00:00' },
    ],
    agent_approvals: [approval()],
    agent_activities: [
      { id: 'a1', task_id: 't1', run_id: 'run-1', seq: 1, type: 'action', body: { op: 'claim' }, ephemeral: false, author_type: 'agent', author_id: 'u-agent', created_at: '2026-10-27T10:01:00+00:00' },
      { id: 'a2', task_id: 't1', run_id: 'run-1', seq: 2, type: 'thought', body: { text: 'hidden' }, ephemeral: true, author_type: 'agent', author_id: 'u-agent', created_at: '2026-10-27T10:01:30+00:00' },
      { id: 'a3', task_id: 't1', run_id: 'run-1', seq: 3, type: 'action', body: { op: 'submit_for_review' }, ephemeral: false, author_type: 'agent', author_id: 'u-agent', created_at: '2026-10-27T10:04:00+00:00' },
    ],
    agent_runs: [
      { id: 'run-1', task_id: 't1', agent_id: 'agent-1', harness: 'codex', brief_version: 2, status: 'waiting', stop_requested_at: null, stop_acked_at: null, last_signal_at: '2026-10-27T10:05:00+00:00', stale_at: null, waiting_on_task_id: null, input_tokens: 10, output_tokens: 5, model: 'm', cost_usd: 0.01, cost_kind: 'measured', error_message: null, started_at: '2026-10-27T10:01:00+00:00', ended_at: null },
      { id: 'run-2', task_id: 'sub1', agent_id: 'agent-2', harness: 'claude_code', brief_version: 1, status: 'running', stop_requested_at: null, stop_acked_at: null, last_signal_at: '2026-10-27T10:05:00+00:00', stale_at: null, waiting_on_task_id: null, input_tokens: 0, output_tokens: 0, model: null, cost_usd: 0, cost_kind: 'unknown', error_message: null, started_at: '2026-10-27T10:02:00+00:00', ended_at: null },
    ],
    agent_reviews: [
      { id: 'rev1', task_id: 't1', run_id: 'lead-run', reviewer_type: 'agent', reviewer_id: 'agent-2', artifact_id: 'art2', artifact_version: 2, brief_version: 2, verdict: 'changes_requested', findings: [{ criterion_id: 'c1', status: 'contradicted' }], evidence: [], outdated_by: null, outdated_at: null, created_at: '2026-10-27T10:04:40+00:00' },
      { id: 'rev0', task_id: 't1', run_id: 'lead-run', reviewer_type: 'agent', reviewer_id: 'agent-2', artifact_id: 'art1', artifact_version: 1, brief_version: 2, verdict: 'changes_requested', findings: [], evidence: [], outdated_by: 'artifact', outdated_at: '2026-10-27T10:04:30+00:00', created_at: '2026-10-27T10:03:30+00:00' },
    ],
    agents: [
      { id: 'agent-1', name: 'Codex worker', role: 'worker', capabilities: { continue: true } },
      { id: 'agent-2', name: 'Lead', role: 'lead', capabilities: { continue: true, events: true } },
    ],
  };
}

Deno.test('get_task with after_seq returns only newer activities, ascending, with next_seq', async () => {
  const h = harness(world());
  const out = await tool('get_task').handler({ task_id: 't1', after_seq: 1 }, h.ctx);
  assert.deepEqual((out.structured.activities as Row[]).map((a) => a.seq), [3]);
  assert.equal(out.structured.next_seq, 3);
});

Deno.test('get_task without after_seq keeps the last N activities and reports next_seq', async () => {
  const h = harness(world());
  const out = await tool('get_task').handler({ task_id: 't1' }, h.ctx);
  assert.deepEqual((out.structured.activities as Row[]).map((a) => a.seq), [1, 3]);
  assert.equal(out.structured.next_seq, 3);
});

Deno.test('get_task with after_seq past the end returns no activities and echoes the cursor', async () => {
  const h = harness(world());
  const out = await tool('get_task').handler({ task_id: 't1', after_seq: 9 }, h.ctx);
  assert.deepEqual(out.structured.activities, []);
  assert.equal(out.structured.next_seq, 9);
});

Deno.test('claim_task with resume passes p_resume and returns the resume context', async () => {
  const calls: [string, Row][] = [];
  const ctx = ctxWith((fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: { task_id: 't1', run_id: 'r1', resume: { checkpoint: null, from: null, summary: 'No checkpoint yet.' } }, error: null }); });
  const out = await tool('claim_task').handler({ task_id: 't1', harness: 'codex', resume: true }, ctx);
  assert.equal(calls[0][1].p_resume, true);
  assert.equal((out.structured.resume as Row).summary, 'No checkpoint yet.');
  assert.match(out.text, /No checkpoint yet./);
});

Deno.test('claim_task without resume sends p_resume false and keeps the description promise', async () => {
  const calls: Row[] = [];
  const ctx = ctxWith((_fn, args) => { calls.push(args); return Promise.resolve({ data: { task_id: 't1', run_id: 'r1' }, error: null }); });
  await tool('claim_task').handler({ task_id: 't1', harness: 'codex' }, ctx);
  assert.equal(calls[0].p_resume, false);
  assert.match(tool('claim_task').description, /only a person reopens it/);
});

Deno.test('request_input passes blocking false and tells the agent to keep working', async () => {
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  const ctx = ctxWith(<T>(fn: string, params: Record<string, unknown>): Promise<DbResult<T>> => {
    calls.push({ fn, params });
    return Promise.resolve({ data: { approval_id: 'q1', blocking: false, status: 'pending' } as T, error: null });
  });
  const out = await tool('request_input').handler({ run_id: 'run-1', question: 'Formal or casual?', blocking: false }, ctx);
  assert.equal(calls[0].fn, 'request_input');
  assert.equal(calls[0].params.p_blocking, false);
  assert.equal(out.structured.blocking, false);
  assert.equal(out.structured.status, 'pending');
  assert.match(out.text, /without blocking/);
});

Deno.test('request_input blocks by default and declares the flag in its schema', async () => {
  const calls: Record<string, unknown>[] = [];
  const ctx = ctxWith(<T>(_fn: string, params: Record<string, unknown>): Promise<DbResult<T>> => {
    calls.push(params);
    return Promise.resolve({ data: { approval_id: 'q2', blocking: true, status: 'pending' } as T, error: null });
  });
  const out = await tool('request_input').handler({ run_id: 'run-1', question: 'Which list?' }, ctx);
  assert.equal(calls[0].p_blocking, true);
  assert.equal(out.structured.blocking, true);
  assert.match(out.text, /input_required/);
  const schema = tool('request_input').inputSchema as { properties: Record<string, { type: string }> };
  assert.equal(schema.properties.blocking.type, 'boolean');
});

Deno.test('await_questions makes the open questions block and says how to wait', async () => {
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  const ctx = ctxWith(<T>(fn: string, params: Record<string, unknown>): Promise<DbResult<T>> => {
    calls.push({ fn, params });
    return Promise.resolve({ data: { questions: 2, task_state: 'input_required' } as T, error: null });
  });
  const out = await tool('await_questions').handler({ run_id: 'run-1' }, ctx);
  assert.deepEqual(calls, [{ fn: 'await_questions', params: { p_run_id: 'run-1' } }]);
  assert.equal(out.structured.task_state, 'input_required');
  assert.match(out.text, /2 questions now block/);
});

Deno.test('request_approval answers approved at once when the autonomy allows the action', async () => {
  const ctx = ctxWith(<T>(_fn: string, _params: Record<string, unknown>): Promise<DbResult<T>> => Promise.resolve({
    data: { approval_id: 'ap9', action_hash: 'h', status: 'approved', receipt: 'r-9', receipt_expires_at: '2026-10-30T10:15:00+00:00',
            auto_approved: { by: 'preset', level: 'balanced' } } as T,
    error: null,
  }));
  const out = await tool('request_approval').handler({ run_id: 'run-1', action: 'publish_page', params: { page_id: 'p1' }, question: 'Publish?' }, ctx);
  assert.equal(out.structured.status, 'approved');
  assert.equal(out.structured.receipt, 'r-9');
  assert.match(out.text, /^Approved automatically \(preset, balanced\)/);
  assert.match(tool('request_approval').description, /status approved/);
});
