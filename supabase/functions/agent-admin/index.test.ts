import assert from 'node:assert/strict';
import { hmacSha256Hex } from '../_shared/hmac.ts';
import { type AgentAdminDeps, type AgentRecord, handleAgentAdmin } from './handler.ts';

const HUMAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AUTH_USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PEPPER = 'login-pepper';

function makeDeps(opts: { member?: boolean; rpcFails?: boolean; owner?: boolean; platformAgent?: AgentRecord | null; rpcCreated?: boolean } = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const log = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const deps: AgentAdminDeps = {
    loginPepper: PEPPER,
    verifyCaller: (token) => Promise.resolve(token === 'human-jwt' ? { userId: HUMAN, principalType: 'human' } : null),
    caller: () => ({
      canManageWorkspace: (ws, uid) => {
        log('canManageWorkspace', ws, uid);
        return Promise.resolve(opts.member ?? true);
      },
      getAgent: () => Promise.resolve(null),
      isWorkspaceOwner: (ws, uid) => {
        log('isWorkspaceOwner', ws, uid);
        return Promise.resolve(opts.owner ?? true);
      },
      getPlatformAgent: (ws) => {
        log('getPlatformAgent', ws);
        return Promise.resolve(opts.platformAgent ?? null);
      },
      rpc: (fn, args) => {
        log('callerRpc', fn, args);
        return Promise.resolve(null);
      },
    }),
    admin: {
      createUser: (attrs) => {
        log('createUser', attrs);
        return Promise.resolve({ id: AUTH_USER });
      },
      updateUserById: (id, attrs) => {
        log('updateUserById', id, attrs);
        return Promise.resolve();
      },
      deleteUser: (id) => {
        log('deleteUser', id);
        return Promise.resolve();
      },
    },
    serviceRpc: (fn, args) => {
      log('serviceRpc', fn, args);
      return opts.rpcFails
        ? Promise.reject({ code: '23505', message: 'duplicate key' })
        : Promise.resolve(fn === 'ensure_platform_agent'
          ? { agent_id: AGENT_ID, auth_user_id: AUTH_USER, created: opts.rpcCreated ?? true }
          : { agent_id: AGENT_ID });
    },
    newId: () => AGENT_ID,
    randomSecret: () => 'temporary-secret',
  };
  return { deps, calls };
}

function create(): Request {
  return new Request('http://localhost/functions/v1/agent-admin', {
    method: 'POST',
    headers: { Authorization: 'Bearer human-jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create_agent', workspace_id: WORKSPACE, name: 'Researcher', kind: 'mcp_client' }),
  });
}

function enable(): Request {
  return new Request('http://localhost/functions/v1/agent-admin', {
    method: 'POST',
    headers: { Authorization: 'Bearer human-jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'enable_platform_agent', workspace_id: WORKSPACE }),
  });
}

Deno.test('non-member gets 403 and no user is created', async () => {
  const { deps, calls } = makeDeps({ member: false });
  const res = await handleAgentAdmin(create(), deps);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'forbidden');
  assert.deepEqual(calls.map((c) => c.op), ['canManageWorkspace']);
});

Deno.test('create_agent calls createUser, updateUserById and the RPC in that order', async () => {
  const { deps, calls } = makeDeps();
  const res = await handleAgentAdmin(create(), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { agent_id: AGENT_ID, auth_user_id: AUTH_USER });
  assert.deepEqual(calls.map((c) => c.op), ['canManageWorkspace', 'createUser', 'updateUserById', 'serviceRpc']);

  const createAttrs = calls[1].args[0] as { email: string; app_metadata: Record<string, unknown> };
  assert.equal(createAttrs.email, `agent+${AGENT_ID}@agents.invalid`);
  assert.equal(createAttrs.app_metadata.principal_type, 'agent');
  assert.equal(createAttrs.app_metadata.agent_id, AGENT_ID);

  const [updatedId, updateAttrs] = calls[2].args as [string, { password: string }];
  assert.equal(updatedId, AUTH_USER);
  assert.equal(updateAttrs.password, await hmacSha256Hex(PEPPER, AUTH_USER));

  const [fn, rpcArgs] = calls[3].args as [string, Record<string, unknown>];
  assert.equal(fn, 'create_agent');
  assert.equal(rpcArgs.p_id, AGENT_ID);
  assert.equal(rpcArgs.p_auth_user_id, AUTH_USER);
  assert.equal(rpcArgs.p_created_by, HUMAN);
});

Deno.test('RPC failure deletes the auth user and returns 500', async () => {
  const { deps, calls } = makeDeps({ rpcFails: true });
  const res = await handleAgentAdmin(create(), deps);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'server_error');
  const last = calls[calls.length - 1];
  assert.equal(last.op, 'deleteUser');
  assert.equal(last.args[0], AUTH_USER);
});

Deno.test('enable_platform_agent: a non-owner gets 403 and nothing is created', async () => {
  const { deps, calls } = makeDeps({ owner: false });
  const res = await handleAgentAdmin(enable(), deps);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'forbidden');
  assert.deepEqual(calls.map((c) => c.op), ['isWorkspaceOwner']);
});
Deno.test('enable_platform_agent returns the existing platform agent without creating a user', async () => {
  const existing = { id: AGENT_ID, workspace_id: WORKSPACE, auth_user_id: AUTH_USER, connection: {} };
  const { deps, calls } = makeDeps({ platformAgent: existing });
  const res = await handleAgentAdmin(enable(), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { agent_id: AGENT_ID, auth_user_id: AUTH_USER, created: false });
  assert.deepEqual(calls.map((c) => c.op), ['isWorkspaceOwner', 'getPlatformAgent']);
});
Deno.test('enable_platform_agent creates the user, sets its login and calls ensure_platform_agent', async () => {
  const { deps, calls } = makeDeps();
  const res = await handleAgentAdmin(enable(), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { agent_id: AGENT_ID, auth_user_id: AUTH_USER, created: true });
  assert.deepEqual(calls.map((c) => c.op), ['isWorkspaceOwner', 'getPlatformAgent', 'createUser', 'updateUserById', 'serviceRpc']);
  const [fn, args] = calls[4].args as [string, Record<string, unknown>];
  assert.equal(fn, 'ensure_platform_agent');
  assert.deepEqual(args, { p_workspace_id: WORKSPACE, p_created_by: HUMAN, p_auth_user_id: AUTH_USER, p_id: AGENT_ID });
  const [, updateAttrs] = calls[3].args as [string, { password: string }];
  assert.equal(updateAttrs.password, await hmacSha256Hex(PEPPER, AUTH_USER));
});
Deno.test('enable_platform_agent deletes the new user when the RPC reports the agent already existed', async () => {
  const { deps, calls } = makeDeps({ rpcCreated: false });
  const res = await handleAgentAdmin(enable(), deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).created, false);
  assert.equal(calls.at(-1)?.op, 'deleteUser');
  assert.equal(calls.at(-1)?.args[0], AUTH_USER);
});
