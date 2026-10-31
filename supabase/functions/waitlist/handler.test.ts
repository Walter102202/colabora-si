import assert from 'node:assert/strict';
import { handleWaitlist, MAX_BODY_BYTES, type JoinResult, type WaitlistDeps } from './handler.ts';
import { addToNotion } from './notion.ts';

const ORIGIN = 'https://colabora.si';

function deps(over: Partial<WaitlistDeps> = {}, result: JoinResult = { outcome: 'added', id: 'row' }) {
  const log: string[] = [];
  const d: WaitlistDeps = {
    appOrigin: ORIGIN,
    hashIp: (ip) => Promise.resolve(`hash(${ip})`),
    join: (email, ipHash) => { log.push(`join:${email}:${ipHash}`); return Promise.resolve(result); },
    markSynced: (id) => { log.push(`synced:${id}`); return Promise.resolve(); },
    copyToNotion: (email) => { log.push(`notion:${email}`); return Promise.resolve(); },
    ...over,
  };
  return { d, log };
}

function post(body: unknown = { email: 'Ana@Company.co ', company: '' }, headers: Record<string, string> = {}) {
  return new Request('http://x/waitlist', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', ...headers },
  });
}

Deno.test('a new address is saved, copied and marked', async () => {
  const { d, log } = deps();
  const res = await handleWaitlist(post(), d);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(log, ['join:ana@company.co:hash(203.0.113.9)', 'notion:ana@company.co', 'synced:row']);
});

Deno.test('a repeated address answers the same and is not copied again', async () => {
  const added = await handleWaitlist(post(), deps().d);
  const { d, log } = deps({}, { outcome: 'exists' });
  const repeated = await handleWaitlist(post(), d);
  assert.deepEqual([repeated.status, await repeated.json()], [added.status, await added.json()]);
  assert.deepEqual(log, ['join:ana@company.co:hash(203.0.113.9)']);
});

Deno.test('a filled honeypot answers success and saves nothing', async () => {
  const { d, log } = deps();
  const res = await handleWaitlist(post({ email: 'bot@spam.co', company: 'ACME' }), d);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(log, []);
});

Deno.test('a rate limit answers 429 and copies nothing', async () => {
  const { d, log } = deps({}, { outcome: 'rate_limited' });
  const res = await handleWaitlist(post(), d);
  assert.deepEqual([res.status, (await res.json()).error], [429, 'rate_limited']);
  assert.deepEqual(log, ['join:ana@company.co:hash(203.0.113.9)']);
});

Deno.test('a Notion failure leaves the row unsynced and the visitor sees success', async () => {
  const { d, log } = deps({ copyToNotion: () => Promise.reject(new Error('timeout')) });
  const res = await handleWaitlist(post(), d);
  assert.equal(res.status, 200);
  assert.deepEqual(log, ['join:ana@company.co:hash(203.0.113.9)']);
});

Deno.test('without the Notion secrets the row is saved and nothing else happens', async () => {
  const { d, log } = deps({ copyToNotion: undefined });
  const res = await handleWaitlist(post(), d);
  assert.equal(res.status, 200);
  assert.deepEqual(log, ['join:ana@company.co:hash(203.0.113.9)']);
});

Deno.test('a malformed address or body is refused before the database', async () => {
  for (const body of [{ email: 'not an email' }, { email: '' }, {}, { email: 42 }, { email: `${'a'.repeat(250)}@b.co` }, 'null']) {
    const { d, log } = deps();
    const res = await handleWaitlist(post(body), d);
    assert.deepEqual([res.status, (await res.json()).error], [400, 'invalid_email']);
    assert.deepEqual(log, []);
  }
  const { d, log } = deps();
  const res = await handleWaitlist(post('{'), d);
  assert.deepEqual([res.status, (await res.json()).error], [400, 'invalid_request']);
  assert.deepEqual(log, []);
});

Deno.test('another origin gets no CORS grant and writes nothing', async () => {
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'https://colabora.si.evil.example' }]) {
    const { d, log } = deps();
    const res = await handleWaitlist(post(undefined, headers), d);
    assert.deepEqual([res.status, (await res.json()).error], [403, 'forbidden_origin']);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    assert.deepEqual(log, []);
  }
  const { d, log } = deps();
  const noOrigin = new Request('http://x/waitlist', { method: 'POST', body: '{"email":"a@b.co"}' });
  assert.equal((await handleWaitlist(noOrigin, d)).status, 403);
  assert.deepEqual(log, []);
});

Deno.test('the preflight allows only the app', async () => {
  const preflight = (origin: string) => new Request('http://x/waitlist', { method: 'OPTIONS', headers: { Origin: origin } });
  const allowed = await handleWaitlist(preflight(ORIGIN), deps().d);
  assert.deepEqual([allowed.status, allowed.headers.get('Access-Control-Allow-Origin')], [204, ORIGIN]);
  const refused = await handleWaitlist(preflight('https://evil.example'), deps().d);
  assert.deepEqual([refused.status, refused.headers.get('Access-Control-Allow-Origin')], [403, null]);
});

Deno.test('only POST joins', async () => {
  const { d, log } = deps();
  const res = await handleWaitlist(new Request('http://x/waitlist', { headers: { Origin: ORIGIN } }), d);
  assert.deepEqual([res.status, (await res.json()).error], [405, 'method_not_allowed']);
  assert.deepEqual(log, []);
});

Deno.test('an oversized body is read to its end and refused', async () => {
  const { d, log } = deps();
  const res = await handleWaitlist(post(`{"email":"${'a'.repeat(MAX_BODY_BYTES)}@b.co"}`), d);
  assert.deepEqual([res.status, (await res.json()).error], [413, 'body_too_large']);
  assert.deepEqual(log, []);
});

Deno.test('the address behind the request prefers the edge header', async () => {
  const hashed: string[] = [];
  const { d } = deps({ hashIp: (ip) => { hashed.push(ip); return Promise.resolve('h'); } });
  await handleWaitlist(post(undefined, { 'cf-connecting-ip': '198.51.100.7' }), d);
  const noHeaders = new Request('http://x/waitlist', { method: 'POST', body: '{"email":"a@b.co"}', headers: { Origin: ORIGIN } });
  await handleWaitlist(noHeaders, d);
  assert.deepEqual(hashed, ['198.51.100.7', 'unknown']);
});

Deno.test('a database failure reaches the caller of the handler', async () => {
  const { d } = deps({ join: () => Promise.reject(new Error('down')) });
  await assert.rejects(handleWaitlist(post(), d), /down/);
});

Deno.test('the Notion page carries the email as title and the date', async () => {
  let url = '';
  let init: RequestInit | undefined;
  const send = ((to: string, options: RequestInit) => { url = to; init = options; return Promise.resolve(new Response('{}')); }) as typeof fetch;
  await addToNotion('secret', 'db', 'ana@company.co', new Date('2026-11-01T10:00:00Z'), send);
  assert.equal(url, 'https://api.notion.com/v1/pages');
  assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer secret');
  assert.deepEqual(JSON.parse(String(init?.body)), {
    parent: { database_id: 'db' },
    properties: { Email: { title: [{ text: { content: 'ana@company.co' } }] }, Joined: { date: { start: '2026-11-01T10:00:00.000Z' } } },
  });
  assert.ok(init?.signal, 'the copy has a timeout');
});

Deno.test('a Notion refusal is a failure', async () => {
  const send = (() => Promise.resolve(new Response('{}', { status: 401 }))) as typeof fetch;
  await assert.rejects(addToNotion('secret', 'db', 'a@b.co', new Date(), send), /notion answered 401/);
});
