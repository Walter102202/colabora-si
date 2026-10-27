import assert from 'node:assert/strict';
import { hmacSha256Hex } from '../_shared/hmac.ts';
import { type AckInput, type DispatchDeps, type DispatchMessage, handleAgentDispatch } from './handler.ts';

const SECRET = 'cron-secret';

function message(id: number, overrides: Partial<DispatchMessage['agent']> = {}, secrets: Record<string, string> = {}): DispatchMessage {
  return {
    msg_id: id,
    read_ct: 1,
    event: {
      event_id: `ev-${id}`,
      workspace_id: 'ws-1',
      task_id: 'task-1',
      run_id: null,
      agent_id: 'agent-1',
      type: 'task.feedback',
      payload: { text: 'Fix row 4', brief_version: 2 },
      seq: id,
      attempt: 0,
      created_at: '2026-10-27T10:00:00+00:00',
    },
    agent: {
      id: 'agent-1', workspace_id: 'ws-1', kind: 'mcp_client', delivery: 'pull', status: 'enabled',
      capabilities: {}, connection: {}, ...overrides,
    },
    secrets,
  };
}

function setup(batches: DispatchMessage[][], respond: (url: string) => Response | Promise<Response> = () => new Response('ok')) {
  const acks: AckInput[] = [];
  const posts: { url: string; init: RequestInit }[] = [];
  const deps: DispatchDeps = {
    secret: SECRET,
    mcpUrl: 'https://project.test/functions/v1/mcp',
    now: () => 1_700_000_000_000,
    dequeue: () => Promise.resolve(batches.shift() ?? []),
    ack: (a) => {
      acks.push(a);
      return Promise.resolve();
    },
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(respond(String(input)));
    }) as typeof fetch,
  };
  return { deps, acks, posts };
}

const req = (secret?: string) =>
  new Request('http://localhost/functions/v1/agent-dispatch', {
    method: 'POST',
    headers: secret ? { 'x-dispatch-secret': secret, 'Content-Type': 'application/json' } : {},
    body: '{"invoked_at":"now"}',
  });

Deno.test('wrong or missing x-dispatch-secret is 401 and nothing is dequeued', async () => {
  let dequeued = false;
  const { deps } = setup([]);
  deps.dequeue = () => {
    dequeued = true;
    return Promise.resolve([]);
  };
  for (const r of [req(), req('nope')]) {
    const res = await handleAgentDispatch(r, deps);
    assert.equal(res.status, 401);
    await res.body?.cancel();
  }
  assert.equal(dequeued, false);
});

Deno.test('pull agents are acked as delivered without any HTTP call', async () => {
  const { deps, acks, posts } = setup([[message(1), message(2)]]);
  const res = await handleAgentDispatch(req(SECRET), deps);
  assert.deepEqual(await res.json(), { processed: 2, delivered: 2, retried: 0, failed: 0 });
  assert.deepEqual(acks.map((a) => [a.msgId, a.eventId, a.ok]), [[1, 'ev-1', true], [2, 'ev-2', true]]);
  assert.equal(posts.length, 0);
});

Deno.test('webhook agents get a signed CloudEvent; 2xx acks ok', async () => {
  const agent = { kind: 'webhook', delivery: 'push' as const, connection: { webhook_url: 'https://hook.example/agent' } };
  const { deps, acks, posts } = setup([[message(7, agent, { webhook_secret: 'whsec' })]]);
  const res = await handleAgentDispatch(req(SECRET), deps);
  await res.body?.cancel();
  assert.equal(posts.length, 1);
  const { url, init } = posts[0];
  assert.equal(url, 'https://hook.example/agent');
  const body = String(init.body);
  const event = JSON.parse(body);
  assert.equal(event.specversion, '1.0');
  assert.equal(event.id, 'ev-7');
  assert.equal(event.type, 'task.feedback');
  assert.equal(event.source, 'workspace/ws-1');
  assert.equal(event.data.task_id, 'task-1');
  assert.equal(event.data.text, 'Fix row 4');
  assert.equal(event.data.mcp_url, 'https://project.test/functions/v1/mcp');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('X-Signature'), null);
  assert.equal(init.redirect, 'manual');
  const t = 1_700_000_000;
  assert.equal(headers.get('X-Agent-Signature'), `t=${t},v1=${await hmacSha256Hex('whsec', `${t}.${body}`)}`);
  assert.equal(headers.get('X-Agent-Event-Id'), 'ev-7');
  assert.equal(headers.get('X-Agent-Attempt'), '1');
  assert.deepEqual(acks, [{ msgId: 7, eventId: 'ev-7', ok: true }]);
});

Deno.test('webhook HTTP status decides the ack: 5xx and 429 retry, 410 and 4xx fail for good', async () => {
  const statuses: Record<string, number> = { a: 503, b: 429, c: 410, d: 400 };
  const agent = (path: string) => ({ kind: 'webhook', delivery: 'push' as const, connection: { webhook_url: `https://hook.example/${path}` } });
  const msgs = Object.keys(statuses).map((path, i) => message(i + 1, agent(path), { webhook_secret: 's' }));
  const { deps, acks } = setup([msgs], (url) => new Response('', { status: statuses[url.split('/').pop()!] }));
  const res = await handleAgentDispatch(req(SECRET), deps);
  assert.deepEqual(await res.json(), { processed: 4, delivered: 0, retried: 2, failed: 2 });
  assert.deepEqual(acks.map((a) => [a.ok, a.retryable, a.error]), [
    [false, true, 'http_503'],
    [false, true, 'http_429'],
    [false, false, 'http_410'],
    [false, false, 'http_400'],
  ]);
});

Deno.test('network errors retry; a webhook agent without url or secret fails without a call', async () => {
  const push = { kind: 'webhook', delivery: 'push' as const };
  const { deps, acks, posts } = setup([[
    message(1, { ...push, connection: { webhook_url: 'https://down.example' } }, { webhook_secret: 's' }),
    message(2, { ...push, connection: {} }, { webhook_secret: 's' }),
    message(3, { ...push, connection: { webhook_url: 'https://hook.example' } }),
    message(4, { ...push, connection: { webhook_url: 'https://169.254.169.254/latest' } }, { webhook_secret: 's' }),
    message(5, { ...push, connection: { webhook_url: 'http://hook.example' } }, { webhook_secret: 's' }),
  ]], () => Promise.reject(new TypeError('connection refused')));
  const res = await handleAgentDispatch(req(SECRET), deps);
  await res.body?.cancel();
  assert.equal(posts.length, 1);
  assert.deepEqual(acks.map((a) => [a.ok, a.retryable, a.error?.split(':')[0]]), [
    [false, true, 'network'],
    [false, false, 'webhook_url_missing'],
    [false, false, 'webhook_secret_missing'],
    [false, false, 'webhook_url_private'],
    [false, false, 'webhook_url_not_https'],
  ]);
});

Deno.test('a full batch dequeues again until the queue is empty', async () => {
  const first = Array.from({ length: 3 }, (_, i) => message(i + 1));
  const { deps, acks } = setup([first, [message(4)]]);
  deps.batch = 3;
  const res = await handleAgentDispatch(req(SECRET), deps);
  assert.equal((await res.json()).processed, 4);
  assert.equal(acks.length, 4);
});
