import assert from 'node:assert/strict';
import { handleWaitlistInvites, type InviteFailure, type InviteRow, type InvitesDeps } from './handler.ts';
import { NotionError } from './notion.ts';

const AT = new Date('2026-11-01T12:00:00.000Z');
const post = (secret = 's') => new Request('http://local', { method: 'POST', headers: { 'x-dispatch-secret': secret } });

function setup(rows: InviteRow[], answers: Record<string, InviteFailure | null | Error> = {}) {
  const calls = { invited: [] as [string, Date][], errors: [] as [string, string][], sent: [] as string[], pending: 0 };
  const deps: InvitesDeps = {
    secret: 's',
    now: () => AT,
    list: {
      pending: async () => { calls.pending++; return rows; },
      markInvited: async (id, at) => { calls.invited.push([id, at]); },
      markError: async (id, message) => { calls.errors.push([id, message]); },
    },
    async invite(email) {
      calls.sent.push(email);
      const answer = answers[email] ?? null;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { deps, calls };
}

async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const original = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try { return { result: await work(), logs }; } finally { console.error = original; }
}

Deno.test('the dispatch secret comes before anything else', async () => {
  const { deps, calls } = setup([{ id: 'p1', email: 'ana@company.co' }]);
  assert.equal((await handleWaitlistInvites(new Request('http://local'), deps)).status, 405);
  assert.equal((await handleWaitlistInvites(post('wrong'), deps)).status, 401);
  assert.equal((await handleWaitlistInvites(post(), { ...deps, secret: '' })).status, 401);
  assert.equal(calls.pending, 0);
  assert.deepEqual(calls.sent, []);
});

Deno.test('without the Notion secrets or the app URL it does nothing', async () => {
  const { deps, calls } = setup([{ id: 'p1', email: 'ana@company.co' }]);
  const res = await handleWaitlistInvites(post(), { ...deps, list: undefined });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skipped: true });
  assert.deepEqual(calls.sent, []);
});

Deno.test('an invitation that leaves records the date', async () => {
  const { deps, calls } = setup([{ id: 'p1', email: '  Ana@Company.CO ' }]);
  const res = await handleWaitlistInvites(post(), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { invited: 1, already: 0, failed: 0, retry: 0 });
  assert.deepEqual(calls.sent, ['ana@company.co']);
  assert.deepEqual(calls.invited, [['p1', AT]]);
  assert.deepEqual(calls.errors, []);
});

Deno.test('a bad address is written back and never reaches Auth', async () => {
  const { deps, calls } = setup([{ id: 'p1', email: 'not an email' }, { id: 'p2', email: '' }, { id: 'p3', email: `${'a'.repeat(250)}@x.co` }]);
  const res = await handleWaitlistInvites(post(), deps);
  assert.deepEqual(await res.json(), { invited: 0, already: 0, failed: 3, retry: 0 });
  assert.deepEqual(calls.sent, []);
  assert.deepEqual(calls.errors, [['p1', 'Not a valid email'], ['p2', 'Not a valid email'], ['p3', 'Not a valid email']]);
});

Deno.test('an address that already has an account says so', async () => {
  const { deps, calls } = setup(
    [{ id: 'p1', email: 'ana@company.co' }, { id: 'p2', email: 'leo@company.co' }],
    { 'ana@company.co': { status: 422, code: 'email_exists' }, 'leo@company.co': { status: 422, code: 'user_already_exists' } },
  );
  const res = await handleWaitlistInvites(post(), deps);
  assert.deepEqual(await res.json(), { invited: 0, already: 2, failed: 0, retry: 0 });
  assert.deepEqual(calls.errors, [['p1', 'Already has an account'], ['p2', 'Already has an account']]);
  assert.deepEqual(calls.invited, []);
});

Deno.test('a rate limit leaves the row alone and stops the batch', async () => {
  const { deps, calls } = setup(
    [{ id: 'p1', email: 'ana@company.co' }, { id: 'p2', email: 'leo@company.co' }],
    { 'ana@company.co': { status: 429, code: 'over_email_send_rate_limit' } },
  );
  const res = await handleWaitlistInvites(post(), deps);
  assert.deepEqual(await res.json(), { invited: 0, already: 0, failed: 0, retry: 1 });
  assert.deepEqual(calls.sent, ['ana@company.co']);
  assert.deepEqual(calls.errors, []);
  assert.deepEqual(calls.invited, []);
});

Deno.test('a server or network failure leaves the row for the next minute and keeps going', async () => {
  const { deps, calls } = setup(
    [{ id: 'p1', email: 'ana@company.co' }, { id: 'p2', email: 'leo@company.co' }, { id: 'p3', email: 'eva@company.co' }, { id: 'p4', email: 'noa@company.co' }],
    { 'ana@company.co': { status: 500 }, 'leo@company.co': { status: 0 }, 'eva@company.co': new TypeError('connection refused') },
  );
  const res = await handleWaitlistInvites(post(), deps);
  assert.deepEqual(await res.json(), { invited: 1, already: 0, failed: 0, retry: 3 });
  assert.deepEqual(calls.errors, []);
  assert.deepEqual(calls.invited, [['p4', AT]]);
});

Deno.test('any other refusal is written back without the address', async () => {
  const { deps, calls } = setup(
    [{ id: 'p1', email: 'ana@company.co' }, { id: 'p2', email: 'leo@company.co' }],
    { 'ana@company.co': { status: 400, code: 'email_address_not_authorized' }, 'leo@company.co': { status: 403, code: 'ana@company.co said no' } },
  );
  const res = await handleWaitlistInvites(post(), deps);
  assert.deepEqual(await res.json(), { invited: 0, already: 0, failed: 2, retry: 0 });
  assert.deepEqual(calls.errors, [['p1', 'Could not send the invite (email_address_not_authorized)'], ['p2', 'Could not send the invite (403)']]);
});

Deno.test('a Notion refusal logs only its code and answers 200', async () => {
  const { deps } = setup([]);
  deps.list!.pending = async () => { throw new NotionError(400); };
  const { result, logs } = await quietly(() => handleWaitlistInvites(post(), deps));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { invited: 0, already: 0, failed: 0, retry: 0, list_failed: true });
  assert.deepEqual(logs, ['waitlist invites: notion query failed: 400']);
});

Deno.test('an unreachable Notion answers 200 without leaking the failure text', async () => {
  const { deps } = setup([]);
  deps.list!.pending = async () => { throw new TypeError('secret detail ana@company.co'); };
  const { result, logs } = await quietly(() => handleWaitlistInvites(post(), deps));
  assert.equal(result.status, 200);
  assert.deepEqual(logs, ['waitlist invites: notion query failed: unreachable']);
});

Deno.test('a failed write back does not stop the batch and logs no address', async () => {
  const { deps, calls } = setup([{ id: 'p1', email: 'ana@company.co' }, { id: 'p2', email: 'leo@company.co' }]);
  const record = deps.list!.markInvited;
  deps.list!.markInvited = async (id, at) => { if (id === 'p1') throw new NotionError(502); await record(id, at); };
  const { result, logs } = await quietly(() => handleWaitlistInvites(post(), deps));
  assert.deepEqual(await result.json(), { invited: 2, already: 0, failed: 0, retry: 0 });
  assert.deepEqual(calls.invited, [['p2', AT]]);
  assert.deepEqual(logs, ['waitlist invites: notion update failed: 502']);
});
