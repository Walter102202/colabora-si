import assert from 'node:assert/strict';
import { handleAccountLink, type AccountLinkDeps } from './handler.ts';

Deno.test('all account outcomes answer before lookup and have identical responses', async () => {
  const responses: string[] = [];
  for (const target of [null, { exists: false, confirmed: false }, { exists: true, confirmed: false }, { exists: true, confirmed: true }]) {
    let sent = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let work!: Promise<unknown>;
    const deps: AccountLinkDeps = {
      appOrigin: 'https://colabora.si',
      background: (promise) => { work = promise; },
      allowed: async () => { await gate; return true; },
      lookup: async () => target,
      send: async () => { sent++; },
    };
    const response = await handleAccountLink(new Request('https://api.test', { method: 'POST', headers: { Origin: deps.appOrigin }, body: JSON.stringify({ email: 'person@test.local' }) }), deps);
    responses.push(`${response.status}:${await response.text()}`);
    assert.equal(sent, 0);
    release(); await work;
    assert.equal(sent, target?.exists ? 1 : 0);
  }
  assert.equal(new Set(responses).size, 1);
});

Deno.test('origin, body limit, rate limit and workspace token binding', async () => {
  const calls: unknown[] = []; const work: Promise<unknown>[] = [];
  const deps: AccountLinkDeps = { appOrigin: 'https://colabora.si', background: (p) => { work.push(p); }, allowed: async () => false, lookup: async (...args) => { calls.push(args); return null; }, send: async () => { throw new Error('must not send'); } };
  const req = (body: string, origin = deps.appOrigin) => new Request('https://api.test', { method: 'POST', headers: { Origin: origin }, body });
  assert.equal((await handleAccountLink(req('{}', 'https://evil.test'), deps)).status, 403);
  assert.equal((await handleAccountLink(req('x'.repeat(2049)), deps)).status, 413);
  const body = JSON.stringify({ email: ' Person@Test.Local ', invite: 'token' });
  assert.equal((await handleAccountLink(req(body), deps)).status, 200);
  await Promise.all(work); assert.equal(calls.length, 0);
  deps.allowed = async () => true;
  await handleAccountLink(req(body), deps); await Promise.all(work);
  assert.deepEqual(calls, [['person@test.local', 'token']]);
});
