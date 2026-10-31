import { assertEquals } from 'jsr:@std/assert@1';
import { handleTramaRuntime, type PlatformAgentRow, type TramaRuntimeDeps } from './handler.ts';

const agent = (id: string, workspace_id: string, serving = true): PlatformAgentRow => ({ id, workspace_id, auth_user_id: `user-${id}`, login_nonce: null, serving });

function makeDeps(over: Partial<TramaRuntimeDeps> = {}) {
  const created: string[] = [];
  const logins: string[] = [];
  const deps: TramaRuntimeDeps = {
    secret: 'runtime-secret',
    loginPepper: 'pepper',
    platformAgents: () => Promise.resolve([agent('a1', 'w1')]),
    workspaces: () => Promise.resolve([{ id: 'w1', owner_id: 'o1' }]),
    createAgent(workspaceId) {
      created.push(workspaceId);
      return Promise.resolve(`new-${workspaceId}`);
    },
    signIn(email) {
      logins.push(email);
      return Promise.resolve({ access_token: 'jwt', expires_in: 3600 });
    },
    log: () => {},
    ...over,
  };
  return { deps, created, logins };
}

function post(body: unknown, secret = 'runtime-secret') {
  return new Request('http://x/trama-runtime', { method: 'POST', headers: { 'X-Runtime-Secret': secret }, body: JSON.stringify(body) });
}

Deno.test('a deployment without the secret has no managed Trama', async () => {
  const { deps, created } = makeDeps({ secret: '' });
  const res = await handleTramaRuntime(post({ action: 'agents' }, ''), deps);
  await res.body?.cancel();
  assertEquals(res.status, 404);
  assertEquals(created, []);
});

Deno.test('a wrong secret gets nothing', async () => {
  const { deps, created, logins } = makeDeps();
  for (const body of [{ action: 'agents' }, { action: 'token', agent_id: 'a1' }]) {
    const res = await handleTramaRuntime(post(body, 'wrong'), deps);
    await res.body?.cancel();
    assertEquals(res.status, 401);
  }
  assertEquals(created, []);
  assertEquals(logins, []);
});

Deno.test('listing creates the Trama of a new workspace and returns it', async () => {
  const { deps, created } = makeDeps({ workspaces: () => Promise.resolve([{ id: 'w1', owner_id: 'o1' }, { id: 'w2', owner_id: 'o2' }]) });
  const res = await handleTramaRuntime(post({ action: 'agents' }), deps);
  assertEquals(await res.json(), { agents: ['a1', 'new-w2'] });
  assertEquals(created, ['w2']);
});

Deno.test('a revoked Trama is neither served nor created again', async () => {
  const { deps, created } = makeDeps({ platformAgents: () => Promise.resolve([agent('a1', 'w1', false)]) });
  const res = await handleTramaRuntime(post({ action: 'agents' }), deps);
  assertEquals(await res.json(), { agents: [] });
  assertEquals(created, []);
});

Deno.test('a workspace that fails to get its agent does not stop the others', async () => {
  const { deps } = makeDeps({
    workspaces: () => Promise.resolve([{ id: 'w1', owner_id: 'o1' }, { id: 'w2', owner_id: 'o2' }]),
    createAgent: () => Promise.reject(new Error('nope')),
  });
  const res = await handleTramaRuntime(post({ action: 'agents' }), deps);
  assertEquals(await res.json(), { agents: ['a1'] });
});

Deno.test('token signs in a serving Trama and refuses anything else', async () => {
  const { deps, logins } = makeDeps({ platformAgents: () => Promise.resolve([agent('a1', 'w1'), agent('a2', 'w2', false)]) });
  const res = await handleTramaRuntime(post({ action: 'token', agent_id: 'a1' }), deps);
  assertEquals(await res.json(), { access_token: 'jwt', expires_in: 3600 });
  assertEquals(logins, ['agent+a1@agents.invalid']);
  for (const agent_id of ['a2', 'not-a-trama']) {
    const refused = await handleTramaRuntime(post({ action: 'token', agent_id }), deps);
    await refused.body?.cancel();
    assertEquals(refused.status, 404);
  }
});

Deno.test('a failed sign-in never reveals why', async () => {
  const { deps } = makeDeps({ signIn: () => Promise.reject(new Error('secret detail')) });
  const res = await handleTramaRuntime(post({ action: 'token', agent_id: 'a1' }), deps);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, 'server_error');
});
