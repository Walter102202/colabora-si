import { handoverTools } from '../_shared/tools/handover.ts';
import assert from 'node:assert/strict';
import { fromDbError, type Db, type DbResult } from '../_shared/db.ts';
import { AuthError, type VerifiedBearer } from '../_shared/jwt.ts';
import { taskTools } from '../_shared/tools/tasks.ts';
import { handleAgentWebhook, statusFor, type WebhookDeps } from './handler.ts';

const AGENT: VerifiedBearer = {
  token: 'agent-jwt',
  claims: {},
  principal: { type: 'agent', userId: 'u-agent', agentId: 'agent-1', workspaceId: 'ws-1', clientId: null },
};

function setup(rpcResult: (fn: string) => DbResult<unknown> = () => ({ data: {}, error: null }), bearer: VerifiedBearer = AGENT) {
  const calls: { fn: string; params: Record<string, unknown>; token: string }[] = [];
  const deps: WebhookDeps = {
    verify: () => Promise.resolve(bearer),
    makeDb: (token): Db => ({
      download: async () => ({ data: null, error: null }),
      rpc: (fn, params) => {
        calls.push({ fn, params, token });
        return Promise.resolve(rpcResult(fn)) as Promise<DbResult<never>>;
      },
      select: () => Promise.resolve({ data: [], error: null }),
    }),
    tools: taskTools,
    appUrl: '',
  };
  return { deps, calls };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/functions/v1/agent-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer agent-jwt', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

Deno.test('an op runs the matching task RPC with the caller token', async () => {
  const { deps, calls } = setup(() => ({ data: { activity_id: 'a1', seq: 4, task_state: 'working' }, error: null }));
  const res = await handleAgentWebhook(post({ op: 'post_activity', args: { run_id: 'run-1', type: 'thought', body: { text: 'hi' } } }), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.result, { activity_id: 'a1', seq: 4, task_state: 'working' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'post_activity');
  assert.equal(calls[0].token, 'agent-jwt');
  assert.deepEqual(calls[0].params, { p_run_id: 'run-1', p_type: 'thought', p_body: { text: 'hi' }, p_ephemeral: undefined, p_idempotency_key: undefined });
});

Deno.test('Idempotency-Key header becomes the tool idempotency key', async () => {
  const { deps, calls } = setup();
  const res = await handleAgentWebhook(
    post({ op: 'post_activity', args: { run_id: 'run-1', type: 'response', body: { text: 'done' } } }, { 'Idempotency-Key': 'evt-42' }),
    deps,
  );
  await res.body?.cancel();
  assert.equal(calls[0].params.p_idempotency_key, 'evt-42');
});

Deno.test('domain errors map to HTTP statuses with the error code', async () => {
  const { deps } = setup(() => ({ data: null, error: { code: 'PT409', message: 'run_active' } }));
  const res = await handleAgentWebhook(post({ op: 'claim_task', args: { task_id: 't1', harness: 'webhook' } }), deps);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'run_active');
  assert.equal(body.ok, false);
  const limited = setup(() => ({ data: null, error: { code: 'PT429', message: 'rate_limited' } }));
  const res2 = await handleAgentWebhook(post({ op: 'ack_stop', args: { run_id: 'r' } }), limited.deps);
  assert.equal(res2.status, 429);
  await res2.body?.cancel();
});

Deno.test('unknown op, bad args and bad JSON are 400 without any RPC', async () => {
  const { deps, calls } = setup();
  for (const body of [{ op: 'drop_tables', args: {} }, { op: 'submit_for_review', args: { run_id: 'r' } }, '{"op":']) {
    const res = await handleAgentWebhook(post(body), deps);
    assert.equal(res.status, 400);
    await res.body?.cancel();
  }
  assert.equal(calls.length, 0);
});

Deno.test('missing token is 401; a person token is 403', async () => {
  const noToken = setup();
  noToken.deps.verify = () => Promise.reject(new AuthError(401, 'invalid_token', 'Missing bearer token.'));
  const res = await handleAgentWebhook(post({ op: 'ack_stop', args: { run_id: 'r' } }), noToken.deps);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('WWW-Authenticate') ?? '', /Bearer/);
  await res.body?.cancel();

  const human = setup(undefined, { ...AGENT, principal: { ...AGENT.principal, type: 'human', agentId: null } });
  const res2 = await handleAgentWebhook(post({ op: 'ack_stop', args: { run_id: 'r' } }), human.deps);
  assert.equal(res2.status, 403);
  assert.equal((await res2.json()).error, 'wrong_principal');
  assert.equal(human.calls.length, 0);
});

Deno.test('GET is 405', async () => {
  const { deps } = setup();
  const res = await handleAgentWebhook(new Request('http://localhost/functions/v1/agent-webhook'), deps);
  assert.equal(res.status, 405);
  await res.body?.cancel();
});

Deno.test('use_partial_writes is a 403 with its own message', () => {
  assert.equal(statusFor('use_partial_writes'), 403);
  assert.equal(
    fromDbError({ code: 'PT403', message: 'use_partial_writes' }).message,
    'Agents do not call apply_page_ops. Write with append_blocks, edit_page, update_block, add_row, update_row or add_comment.',
  );
});

Deno.test('hand_over runs through the webhook with the Idempotency-Key header', async () => {
  const { deps, calls } = setup(() => ({ data: { activity_id: 'a9', seq: 9, task_state: 'queued', replayed: false }, error: null }));
  const res = await handleAgentWebhook(post({ op: 'hand_over', args: { run_id: 'run-1', checkpoint: { v: 1, next_step: 'x', handover_note: 'Stopping' } } }, { 'Idempotency-Key': 'evt-7' }), { ...deps, tools: [...taskTools, ...handoverTools] });
  await res.body?.cancel();
  assert.equal(res.status, 200);
  assert.equal(calls[0].fn, 'hand_over');
  assert.equal(calls[0].params.p_idempotency_key, 'evt-7');
});
