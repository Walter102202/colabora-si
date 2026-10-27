import assert from 'node:assert/strict';
import { agentEmail } from '../_shared/agentLogin.ts';
import { hmacSha256Hex, sha256Hex } from '../_shared/hmac.ts';
import { type AgentTokenDeps, FailureLimiter, handleAgentToken, type TokenRow } from './handler.ts';

const PEPPER = 'db-pepper';
const LOGIN_PEPPER = 'login-pepper';
const TOKEN = 'agt_' + 'A1b2C3d4E5'.repeat(4);
const ROW: TokenRow = {
  agent_id: '11111111-1111-4111-8111-111111111111',
  auth_user_id: '22222222-2222-4222-8222-222222222222',
  workspace_id: '33333333-3333-4333-8333-333333333333',
  scopes: ['mcp'],
  token_id: '44444444-4444-4444-8444-444444444444',
};

function makeDeps(overrides: Partial<AgentTokenDeps> = {}) {
  const signIns: Array<{ email: string; password: string }> = [];
  const deps: AgentTokenDeps = {
    getPepper: () => Promise.resolve(PEPPER),
    lookupToken: async (hash) => (hash === (await sha256Hex(PEPPER + TOKEN)) ? ROW : null),
    getLoginNonce: () => Promise.resolve(null),
    signIn: (email, password) => {
      signIns.push({ email, password });
      return Promise.resolve({ access_token: 'jwt.for.agent', expires_in: 3600 });
    },
    loginPepper: LOGIN_PEPPER,
    now: () => 1_000_000,
    limiter: new FailureLimiter(),
    ...overrides,
  };
  return { deps, signIns };
}

function post(body: unknown, ip = '203.0.113.7'): Request {
  return new Request('http://localhost/functions/v1/agent-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

Deno.test('valid PAT returns an access token and never a refresh token', async () => {
  const { deps, signIns } = makeDeps();
  const res = await handleAgentToken(post({ token: TOKEN }), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.access_token, 'jwt.for.agent');
  assert.equal(body.token_type, 'Bearer');
  assert.ok(body.expires_in <= 3600);
  assert.equal(body.agent_id, ROW.agent_id);
  assert.equal(body.workspace_id, ROW.workspace_id);
  assert.equal('refresh_token' in body, false);
  assert.deepEqual(signIns, [
    { email: agentEmail(ROW.agent_id), password: await hmacSha256Hex(LOGIN_PEPPER, ROW.auth_user_id) },
  ]);
});

Deno.test('unknown hash returns 401 invalid_token', async () => {
  const { deps } = makeDeps({ lookupToken: () => Promise.resolve(null) });
  const res = await handleAgentToken(post({ token: TOKEN }), deps);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'invalid_token');
});

Deno.test('disabled agent or kill switch returns 403 agent_disabled', async () => {
  const { deps } = makeDeps({ lookupToken: () => Promise.reject({ code: 'agent_disabled' }) });
  const res = await handleAgentToken(post({ token: TOKEN }), deps);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'agent_disabled');
});

Deno.test('20 failures in a minute from the same IP returns 429', async () => {
  const { deps } = makeDeps({ lookupToken: () => Promise.resolve(null) });
  for (let i = 0; i < 20; i++) {
    const res = await handleAgentToken(post({ token: TOKEN }), deps);
    assert.equal(res.status, 401);
    await res.body?.cancel();
  }
  const blocked = await handleAgentToken(post({ token: TOKEN }), deps);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  await blocked.body?.cancel();
  const otherIp = await handleAgentToken(post({ token: TOKEN }, '198.51.100.9'), deps);
  assert.equal(otherIp.status, 401);
  await otherIp.body?.cancel();
});

Deno.test('malformed token returns 400 invalid_request', async () => {
  const { deps } = makeDeps();
  for (const token of ['agt_short', 'pat_' + 'a'.repeat(40), 42]) {
    const res = await handleAgentToken(post({ token }), deps);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_request');
  }
});
