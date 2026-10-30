import assert from 'node:assert/strict';
import { hmacSha256Hex } from '../_shared/hmac.ts';
import { webhookSecret } from '../_shared/ciWebhook.ts';
import { handleGithubWebhook, type GithubWebhookDeps } from './handler.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const PEPPER = 'local-ci-pepper';
const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/check_run_completed.json', import.meta.url)));
function setup(error: string | null = null) {
  const calls: unknown[][] = [];
  const deps: GithubWebhookDeps = { pepper: PEPPER, record: async (...args) => {
    calls.push(args); return { data: { recorded: true, tasks: 2 }, error: error ? { message: error } : null };
  } };
  return { calls, deps };
}
async function request(body: unknown = fixture, event = 'check_run', signature?: string) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`http://localhost/functions/v1/github-webhook/${ID}`, { method: 'POST', body: raw,
    headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': signature ?? `sha256=${await hmacSha256Hex(await webhookSecret(PEPPER, ID), raw)}` } });
}
Deno.test('GitHub accepts only POST and a UUID connection path', async () => {
  const { deps, calls } = setup();
  assert.equal((await handleGithubWebhook(new Request(`http://localhost/${ID}`), deps)).status, 405);
  assert.equal((await handleGithubWebhook(new Request('http://localhost/not-a-uuid', { method: 'POST' }), deps)).status, 404);
  assert.equal(calls.length, 0);
});
Deno.test('GitHub rejects oversized bodies and an absent pepper', async () => {
  const { deps, calls } = setup();
  assert.equal((await handleGithubWebhook(await request('é'.repeat(524289)), deps)).status, 413);
  deps.pepper = '';
  const res = await handleGithubWebhook(await request(), deps);
  assert.equal(res.status, 500); assert.equal((await res.json()).error, 'misconfigured');
  assert.equal(calls.length, 0);
});
Deno.test('GitHub checks the signature before parsing and never records an invalid delivery', async () => {
  const { deps, calls } = setup();
  assert.equal((await handleGithubWebhook(await request('not json', 'check_run', 'sha256=wrong'), deps)).status, 401);
  assert.equal((await handleGithubWebhook(await request('not json'), deps)).status, 400);
  const missing = await request(); missing.headers.delete('X-Hub-Signature-256');
  assert.equal((await handleGithubWebhook(missing, deps)).status, 401);
  assert.equal(calls.length, 0);
});
Deno.test('GitHub ping records the repository and no run', async () => {
  const { deps, calls } = setup();
  assert.equal((await handleGithubWebhook(await request({ repository: fixture.repository }, 'ping'), deps)).status, 200);
  assert.deepEqual(calls, [[ID, fixture.repository.full_name, null]]);
});
Deno.test('GitHub ignores other events and unfinished checks', async () => {
  const { deps, calls } = setup();
  assert.equal((await handleGithubWebhook(await request(fixture, 'push'), deps)).status, 204);
  assert.equal((await handleGithubWebhook(await request({ ...fixture, action: 'created' }), deps)).status, 204);
  assert.equal(calls.length, 0);
});
Deno.test('GitHub maps the complete check_run fixture and reports what was recorded', async () => {
  const { deps, calls } = setup();
  const res = await handleGithubWebhook(await request(), deps);
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { ok: true, recorded: true, tasks: 2 });
  const c = fixture.check_run;
  assert.deepEqual(calls, [[ID, fixture.repository.full_name, { id: c.id, name: c.name, head_sha: c.head_sha,
    head_branch: c.check_suite.head_branch, conclusion: c.conclusion, html_url: c.html_url,
    app_slug: c.app.slug, started_at: c.started_at, completed_at: c.completed_at }]]);
});
Deno.test('GitHub handles missing optional branch/app and rejects malformed event objects', async () => {
  const { deps, calls } = setup();
  assert.equal((await handleGithubWebhook(await request({ ...fixture, check_run: { ...fixture.check_run, check_suite: null, app: null } }), deps)).status, 200);
  assert.equal((calls[0][2] as Record<string, unknown>).head_branch, null);
  assert.equal((calls[0][2] as Record<string, unknown>).app_slug, null);
  for (const body of [null, [], {}, { action: 'completed', repository: fixture.repository }]) {
    assert.equal((await handleGithubWebhook(await request(body), deps)).status, 400);
  }
});
for (const [message, status] of Object.entries({ connection_revoked: 410, repo_mismatch: 403, not_found: 404, invalid_input: 400, unknown: 500 })) {
  Deno.test(`GitHub maps record failure ${message}`, async () => {
    assert.equal((await handleGithubWebhook(await request(), setup(message).deps)).status, status);
  });
}
