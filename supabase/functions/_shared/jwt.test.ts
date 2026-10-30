import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { AuthError, type ClaimsVerifier, resolveLinkedSession, type VerifiedBearer, verifyBearer } from './jwt.ts';

const URL_BASE = 'http://project.test';
const ENV = { SUPABASE_URL: URL_BASE, SUPABASE_ANON_KEY: 'anon' };
const KID = 'test-key-1';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';

const linkedBearer = (clientId: string | null = 'chat'): VerifiedBearer => ({ token: 'caller-token', claims: {},
  principal: { type: 'human', userId: 'person', agentId: null, workspaceId: null, clientId } });

Deno.test('direct sessions do not resolve a link', async () => {
  const bearer = linkedBearer(null);
  assert.equal(await resolveLinkedSession(bearer, () => { throw new Error('unexpected RPC'); }), bearer);
});
Deno.test('an unlinked OAuth session stays human', async () => {
  const bearer = linkedBearer();
  assert.equal(await resolveLinkedSession(bearer, async () => ({ data: { principal_type: 'human' }, error: null })), bearer);
});
Deno.test('a linked OAuth session uses the database agent identity and keeps the caller token', async () => {
  const bearer = linkedBearer();
  const result = await resolveLinkedSession(bearer, async () => ({ data: {
    principal_type: 'agent', user_id: 'agent-user', agent_id: AGENT_ID, workspace_id: 'workspace', via_user: 'person',
  }, error: null }));
  assert.equal(result.token, bearer.token);
  assert.deepEqual(result.principal, { type: 'agent', userId: 'agent-user', agentId: AGENT_ID,
    workspaceId: 'workspace', viaUserId: 'person', clientId: 'chat' });
});
Deno.test('a revoked OAuth link is an invalid token', async () => {
  await assert.rejects(resolveLinkedSession(linkedBearer(), async () => ({ data: null, error: { message: 'link_revoked' } })),
    (e) => e instanceof AuthError && e.status === 401 && e.code === 'invalid_token');
});
Deno.test('unresolved OAuth sessions fail closed', async () => {
  for (const error of [null, { message: 'session_link_not_applied' }, { message: 'offline' }]) {
    await assert.rejects(resolveLinkedSession(linkedBearer(), async () => ({ data: null, error })),
      (e) => e instanceof AuthError && e.status === 403 && e.code === 'wrong_principal');
  }
});

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function keyPair() {
  return await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

const signing = await keyPair();
const otherKey = await keyPair();
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', signing.publicKey)), kid: KID, alg: 'ES256', use: 'sig' };

async function sign(payload: Record<string, unknown>, key: CryptoKey = signing.privateKey): Promise<string> {
  const input = `${enc({ alg: 'ES256', kid: KID, typ: 'JWT' })}.${enc(payload)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: '22222222-2222-4222-8222-222222222222',
    role: 'authenticated',
    aud: 'authenticated',
    iss: `${URL_BASE}/auth/v1`,
    iat: now,
    exp: now + 3600,
    app_metadata: { principal_type: 'agent', agent_id: AGENT_ID, workspace_id: '33333333-3333-4333-8333-333333333333' },
    ...overrides,
  };
}

// Real supabase-js getClaims; the JWKS comes from a fake fetch, so nothing leaves the process.
const client = createClient(URL_BASE, 'anon', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    fetch: (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/auth/v1/.well-known/jwks.json')) {
        return Promise.resolve(new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{"message":"not found"}', { status: 404 }));
    },
  },
});
const verify: ClaimsVerifier = async (token) => {
  const { data, error } = await client.auth.getClaims(token);
  return { data: data ? { claims: data.claims as unknown as Record<string, unknown> } : null, error };
};

const req = (token?: string) =>
  new Request('http://localhost/functions/v1/mcp', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });

async function rejects(token: string | undefined, status: number, code: string) {
  await assert.rejects(verifyBearer(req(token), ENV, verify), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

Deno.test('valid ES256 agent token verified against the JWKS', async () => {
  const out = await verifyBearer(req(await sign(claims())), ENV, verify);
  assert.equal(out.principal.type, 'agent');
  assert.equal(out.principal.agentId, AGENT_ID);
  assert.equal(out.principal.clientId, null);
});

Deno.test('signature from another key is rejected', async () => {
  await rejects(await sign(claims(), otherKey.privateKey), 401, 'invalid_token');
});

Deno.test('expired token is rejected', async () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  await rejects(await sign(claims({ iat: past - 3600, exp: past })), 401, 'invalid_token');
});

Deno.test('token from another issuer is rejected', async () => {
  await rejects(await sign(claims({ iss: 'https://other.example/auth/v1' })), 401, 'invalid_token');
});

Deno.test('audience other than authenticated is rejected', async () => {
  await rejects(await sign(claims({ aud: 'mcp' })), 401, 'invalid_token');
});

Deno.test('service_role and anon tokens are wrong_principal', async () => {
  await rejects(await sign(claims({ role: 'service_role' })), 403, 'wrong_principal');
  await rejects(await sign(claims({ role: 'anon' })), 403, 'wrong_principal');
  await rejects('sb_secret_abcdef', 403, 'wrong_principal');
  await rejects('sb_publishable_abcdef', 403, 'wrong_principal');
});

Deno.test('missing principal_type means a person, with client_id kept', async () => {
  const out = await verifyBearer(req(await sign(claims({ app_metadata: {}, client_id: 'chat-client' }))), ENV, verify);
  assert.equal(out.principal.type, 'human');
  assert.equal(out.principal.agentId, null);
  assert.equal(out.principal.clientId, 'chat-client');
});

Deno.test('agent token without agent_id is rejected', async () => {
  await rejects(await sign(claims({ app_metadata: { principal_type: 'agent' } })), 401, 'invalid_token');
});

Deno.test('missing or malformed bearer is invalid_token', async () => {
  await rejects(undefined, 401, 'invalid_token');
  await rejects('not-a-jwt', 401, 'invalid_token');
});
