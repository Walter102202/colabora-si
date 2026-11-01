import assert from 'node:assert/strict';
import { markInvited, markInviteError, NotionError, pendingInvites } from './notion.ts';

type Seen = { url: string; init: RequestInit };

function fake(status: number, body: unknown) {
  const seen: Seen[] = [];
  const send = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { send, seen };
}

Deno.test('the query asks only for rows marked Invite, not yet invited and without an error', async () => {
  const { send, seen } = fake(200, { results: [] });
  assert.deepEqual(await pendingInvites('tok', 'db-1', send), []);
  assert.equal(seen[0].url, 'https://api.notion.com/v1/databases/db-1/query');
  assert.equal(seen[0].init.method, 'POST');
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok');
  assert.equal(headers['Notion-Version'], '2022-06-28');
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), {
    page_size: 10,
    filter: { and: [
      { property: 'Invite', checkbox: { equals: true } },
      { property: 'Invited', date: { is_empty: true } },
      { property: 'Invite error', rich_text: { is_empty: true } },
    ] },
  });
});

Deno.test('each row carries its page and the text of its Email title', async () => {
  const { send } = fake(200, { results: [
    { id: 'p1', properties: { Email: { title: [{ plain_text: 'ana@' }, { plain_text: 'company.co' }] } } },
    { id: 'p2', properties: { Email: { title: [] } } },
    { id: 'p3', properties: {} },
  ] });
  assert.deepEqual(await pendingInvites('tok', 'db-1', send), [
    { id: 'p1', email: 'ana@company.co' },
    { id: 'p2', email: '' },
    { id: 'p3', email: '' },
  ]);
});

Deno.test('a refused query throws its status', async () => {
  const { send } = fake(403, { message: 'no access' });
  await assert.rejects(() => pendingInvites('tok', 'db-1', send), (e: unknown) => e instanceof NotionError && e.status === 403);
});

Deno.test('an invitation writes the date on the page', async () => {
  const { send, seen } = fake(200, {});
  await markInvited('tok', 'p1', new Date('2026-11-01T12:00:00.000Z'), send);
  assert.equal(seen[0].url, 'https://api.notion.com/v1/pages/p1');
  assert.equal(seen[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { properties: { Invited: { date: { start: '2026-11-01T12:00:00.000Z' } } } });
});

Deno.test('a problem writes its text on the page', async () => {
  const { send, seen } = fake(200, {});
  await markInviteError('tok', 'p1', 'Not a valid email', send);
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { properties: { 'Invite error': { rich_text: [{ text: { content: 'Not a valid email' } }] } } });
});

Deno.test('a refused update throws its status', async () => {
  const { send } = fake(409, {});
  await assert.rejects(() => markInvited('tok', 'p1', new Date(), send), (e: unknown) => e instanceof NotionError && e.status === 409);
});
