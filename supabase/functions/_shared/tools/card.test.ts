import assert from 'node:assert/strict';
import { buildServer } from '../../mcp/server.ts';
import type { Db, DbError, DbResult, Filter, SelectSpec } from '../db.ts';
import { ToolError } from '../db.ts';
import type { VerifiedBearer } from '../jwt.ts';
import { handleMcp, type ToolContext, type ToolDef } from '../mcp.ts';
import { CARD_MIME, CARD_URI, cardTools, currentArtifact, taskLink } from './card.ts';
import { taskTools } from './tasks.ts';

type Row = Record<string, unknown>;

const tool = (name: string) => [...cardTools, ...taskTools].find((t) => t.name === name) as ToolDef;

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

const AGENT: ToolContext['principal'] = { type: 'agent', userId: 'u-agent', agentId: 'agent-1', workspaceId: 'w1', clientId: null };

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

Deno.test('get_task returns the card: run, pending approval, current artifact, latest review, subtasks with agent names, app_url', async () => {
  const h = harness(world());
  const out = await tool('get_task').handler({ task_id: 't1' }, h.ctx);
  const s = out.structured;
  assert.equal(s.kind, 'task');
  assert.equal((s.task as Row).id, 't1');
  assert.deepEqual((s.task as Row).depends_on_task_ids, []);
  assert.equal((s.run as Row).id, 'run-1');
  assert.equal((s.approval as Row).id, 'ap1');
  assert.equal((s.approval as Row).artifact_version, 2);
  assert.equal((s.artifact as Row).id, 'art2');
  assert.equal((s.review as Row).id, 'rev1');
  assert.equal((s.brief as Row).objective, 'Dedupe');
  assert.deepEqual((s.activities as Row[]).map((a) => a.seq), [1, 3]);
  assert.deepEqual((s.artifacts as Row[]).map((a) => a.id), ['art1', 'art2']);
  assert.deepEqual((s.approvals_pending as Row[]).map((a) => a.id), ['ap1']);
  const subtasks = s.subtasks as { task: Row; run: Row | null; agent_name: string | null }[];
  assert.deepEqual(subtasks.map((x) => [x.task.id, x.run?.id ?? null, x.agent_name]), [['sub1', 'run-2', 'Lead']]);
  assert.deepEqual((s.agents as Row[]).map((a) => a.name).sort(), ['Codex worker', 'Lead']);
  assert.equal(s.app_url, 'https://app.example');
  assert.deepEqual(h.rpcs, []);
});

Deno.test('currentArtifact picks the highest version, then the latest', () => {
  assert.equal(currentArtifact([]), null);
  const pick = currentArtifact([
    { id: 'a', version: 2, created_at: '2026-10-27T10:00:00+00:00' },
    { id: 'b', version: 3, created_at: '2026-10-27T09:00:00+00:00' },
    { id: 'c', version: 3, created_at: '2026-10-27T11:00:00+00:00' },
  ]);
  assert.equal(pick?.id, 'c');
});

Deno.test('decide_approval and close_task refuse agents with humans_only before touching the database', async () => {
  for (const [name, args] of [['decide_approval', { approval_id: 'ap1', decision: 'approve' }], ['close_task', { task_id: 't1', acceptance: 'accepted' }], ['list_waiting_on_me', {}]] as const) {
    const h = harness(world(), { principal: AGENT });
    await assert.rejects(tool(name).handler({ ...args }, h.ctx), (err: unknown) => err instanceof ToolError && err.code === 'humans_only');
    assert.deepEqual(h.rpcs, []);
  }
});

Deno.test('decide_approval calls the RPC as the person and returns the refreshed card without the receipt', async () => {
  const tables = world();
  const h = harness(tables, {
    onRpc: ({ fn }) => {
      if (fn !== 'decide_approval') return;
      tables.agent_approvals[0] = approval({ status: 'decided', decision: 'approve' });
      tables.agent_tasks[0] = task({ state: 'working', waiting_on: null });
      return { data: { status: 'decided', receipt: 'secret-receipt', receipt_expires_at: '2026-10-27T10:20:00+00:00' } };
    },
  });
  const out = await tool('decide_approval').handler({ approval_id: 'ap1', decision: 'approve' }, h.ctx);
  assert.deepEqual(h.rpcs, [{ fn: 'decide_approval', params: { p_approval_id: 'ap1', p_decision: 'approve', p_response: null } }]);
  assert.equal(out.structured.status, 'decided');
  assert.equal('receipt' in out.structured, false);
  assert.equal(out.structured.kind, 'task');
  assert.equal((out.structured.task as Row).state, 'working');
  assert.equal(out.structured.approval, null);
  assert.match(out.text, /approve.*now working/);

  const answered = await tool('decide_approval').handler({ approval_id: 'ap1', decision: 'respond', response: { text: 'Keep the oldest' } }, h.ctx);
  assert.deepEqual(h.rpcs[1].params, { p_approval_id: 'ap1', p_decision: 'respond', p_response: { text: 'Keep the oldest' } });
  assert.equal(answered.structured.kind, 'task');

  await assert.rejects(tool('decide_approval').handler({ approval_id: 'nope', decision: 'approve' }, h.ctx), (err: unknown) => err instanceof ToolError && err.code === 'not_found');
});

Deno.test('a control RPC the database refuses becomes direct_session_required with the task link', async () => {
  const h = harness(world(), {
    principal: { type: 'human', userId: 'u-owner', agentId: null, workspaceId: 'w1', clientId: 'chatgpt' },
    onRpc: () => ({ error: { code: 'PT403', message: 'direct_session_required' } }),
  });
  await assert.rejects(tool('close_task').handler({ task_id: 't1', acceptance: 'accepted', note: 'Nice' }, h.ctx), (err: unknown) => {
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'direct_session_required');
    assert.match(err.message, /Open the task in colabora/);
    assert.deepEqual(err.detail, { task_id: 't1', url: 'https://app.example/p/row1?task=t1' });
    return true;
  });
  assert.deepEqual(h.rpcs, [{ fn: 'close_task', params: { p_task_id: 't1', p_acceptance: 'accepted', p_note: 'Nice' } }]);
  assert.equal(taskLink('https://app.example', 'row 1', 'a/b'), 'https://app.example/p/row%201?task=a%2Fb');
});

Deno.test('a refused decide_approval links straight to the approval with an #approval fragment', async () => {
  const h = harness(world(), {
    principal: { type: 'human', userId: 'u-owner', agentId: null, workspaceId: 'w1', clientId: 'chatgpt' },
    onRpc: () => ({ error: { code: 'PT403', message: 'direct_session_required' } }),
  });
  await assert.rejects(tool('decide_approval').handler({ approval_id: 'ap1', decision: 'approve' }, h.ctx), (err: unknown) => {
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'direct_session_required');
    assert.deepEqual(err.detail, { task_id: 't1', url: 'https://app.example/p/row1?task=t1#approval-ap1' });
    return true;
  });
});

Deno.test('close_task calls the RPC and returns the closed task as a card', async () => {
  const tables = world();
  const h = harness(tables, {
    onRpc: ({ fn }) => {
      if (fn === 'close_task') {
        tables.agent_tasks[0] = task({ state: 'done', acceptance: 'accepted', active_run_id: null, closed_at: '2026-10-27T10:10:00+00:00', closed_by: 'u-owner' });
        tables.agent_approvals[0] = approval({ status: 'cancelled' });
      }
      return { data: {} };
    },
  });
  const out = await tool('close_task').handler({ task_id: 't1', acceptance: 'accepted' }, h.ctx);
  assert.deepEqual(h.rpcs, [{ fn: 'close_task', params: { p_task_id: 't1', p_acceptance: 'accepted', p_note: undefined } }]);
  assert.equal(out.structured.task_state, 'done');
  assert.equal(out.structured.kind, 'task');
  assert.equal(out.structured.run, null);
  assert.equal(out.structured.approval, null);
  assert.equal((out.structured.task as Row).closed_by, 'u-owner');
  await assert.rejects(tool('close_task').handler({ task_id: 'missing', acceptance: 'rejected' }, h.ctx), (err: unknown) => err instanceof ToolError && err.code === 'not_found');
});

Deno.test('list_waiting_on_me: one row per task that needs the person, with the reason and the link', async () => {
  const tables = world();
  tables.agent_tasks = [
    task({ id: 'ap', title: 'Email', state: 'input_required', waiting_on: 'human', updated_at: '2026-10-27T10:09:00+00:00' }),
    task({ id: 'q', title: 'Tone', state: 'input_required', waiting_on: 'human', delegate_agent_id: 'agent-2', updated_at: '2026-10-27T10:08:00+00:00' }),
    task({ id: 'r', title: 'Pricing', state: 'ready_for_review', waiting_on: null, delegate_agent_id: null, updated_at: '2026-10-27T10:07:00+00:00' }),
    task({ id: 'esc', title: 'Escalated', state: 'input_required', waiting_on: 'human', updated_at: '2026-10-27T10:06:00+00:00' }),
    task({ id: 'lead', title: 'On the Lead', state: 'input_required', waiting_on: 'lead', updated_at: '2026-10-27T10:05:00+00:00' }),
    task({ id: 'busy', title: 'Working', state: 'working', updated_at: '2026-10-27T10:04:00+00:00' }),
    task({ id: 'theirs', title: 'Someone else', state: 'ready_for_review', owner_user_id: 'u-other', updated_at: '2026-10-27T10:03:00+00:00' }),
  ];
  tables.agent_approvals = [
    approval({ id: 'ap-a', task_id: 'ap' }),
    approval({ id: 'ap-q', task_id: 'q', kind: 'elicitation', action: null, question: 'Formal or casual?', options: ['respond'] }),
    approval({ id: 'ap-old', task_id: 'r', status: 'decided' }),
  ];
  const h = harness(tables);
  const out = await tool('list_waiting_on_me').handler({}, h.ctx);
  assert.equal(out.structured.kind, 'waiting');
  assert.equal(out.structured.app_url, 'https://app.example');
  const items = out.structured.items as Row[];
  assert.deepEqual(items.map((i) => [i.task_id, i.reason, i.agent_name, (i.approval as Row | null)?.id ?? null]), [
    ['ap', 'approval', 'Codex worker', 'ap-a'],
    ['q', 'input', 'Lead', 'ap-q'],
    ['r', 'review', null, null],
    ['esc', 'input', 'Codex worker', null],
  ]);
  assert.equal(items[0].url, 'https://app.example/p/row1?task=ap');
  assert.deepEqual(Object.keys(items[1].approval as Row).sort(), ['action', 'expires_at', 'id', 'kind', 'options', 'question']);
  assert.match(out.text, /^4 tasks waiting on you: 1 to approve, 2 with a question, 1 to review\./);
  assert.match(out.text, /- Tone: has a question for you \(Formal or casual\?\) https:\/\/app\.example\/p\/row1\?task=q/);

  const none = await tool('list_waiting_on_me').handler({}, harness({ agent_tasks: [] }).ctx);
  assert.equal(none.text, 'Nothing is waiting on you.');
  assert.deepEqual(none.structured.items, []);
});

// ---------------------------------------------------------------------------
// Through the protocol: the resource and the tool metadata hosts look at.
// ---------------------------------------------------------------------------

const BEARER: VerifiedBearer = {
  token: 'jwt',
  claims: {},
  principal: { type: 'human', userId: 'u1', agentId: null, workspaceId: 'w1', clientId: null },
};

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const req = new Request('http://localhost/functions/v1/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer jwt' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const res = await handleMcp(req, buildServer(), {
    env: { SUPABASE_URL: 'http://project.test', APP_URL: 'https://app.example/' },
    verify: () => Promise.resolve(BEARER),
    makeDb: () => harness({}).ctx.db,
    log: () => {},
  });
  return (await res.json()).result;
}

Deno.test('the card is a ui:// resource with the MCP Apps mimetype, listed and readable, self-contained', async () => {
  const listed = await rpc('resources/list');
  const entry = listed.resources.find((r: Row) => r.uri === CARD_URI);
  assert.ok(entry, 'card listed');
  assert.equal(entry.mimeType, CARD_MIME);
  assert.equal(entry.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(entry._meta, { ui: { prefersBorder: true } });

  const read = await rpc('resources/read', { uri: CARD_URI });
  const content = read.contents[0];
  assert.equal(content.uri, CARD_URI);
  assert.equal(content.mimeType, CARD_MIME);
  assert.deepEqual(content._meta, { ui: { prefersBorder: true } });
  assert.match(content.text, /^<!doctype html>/i);
  assert.match(content.text, /<script type="module">/);
  assert.match(content.text, /<style>/);
  assert.doesNotMatch(content.text, /\s(src|href)="\/assets\//);
  assert.doesNotMatch(content.text, /<link rel="modulepreload"/);
  assert.ok(content.text.length < 300 * 1024, `card is ${content.text.length} chars`);
});

Deno.test('tools that return card data carry _meta.ui.resourceUri; the others do not', async () => {
  const { tools } = await rpc('tools/list');
  const meta = Object.fromEntries(tools.map((t: Row) => [t.name, t._meta ?? null]));
  for (const name of ['get_task', 'decide_approval', 'close_task', 'list_waiting_on_me']) {
    assert.deepEqual(meta[name], { ui: { resourceUri: CARD_URI }, 'ui/resourceUri': CARD_URI, 'openai/outputTemplate': CARD_URI }, name);
  }
  for (const name of ['list_my_tasks', 'send_message', 'review_task', 'read_page']) assert.equal(meta[name], null, name);
  const review = tools.find((t: Row) => t.name === 'review_task');
  assert.deepEqual(review.inputSchema.required, ['task_id', 'verdict', 'findings']);
});
