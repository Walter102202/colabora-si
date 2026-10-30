import assert from 'node:assert/strict';
import { hmacSha256Hex } from '../_shared/hmac.ts';
import { agentLoginPassword } from '../_shared/agentLogin.ts';
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
    ciPepper: 'ci-pepper',
    functionsBaseUrl: 'https://api.test/functions/v1',
    verifyCaller: (token) =>
      Promise.resolve(
        token === 'human-jwt' ? { userId: HUMAN, principalType: 'human', clientId: null } : token === 'agent-jwt' ? { userId: AUTH_USER, principalType: 'agent', clientId: null } : null,
      ),
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
        return Promise.resolve(fn === 'create_ci_connection' ? { id: AGENT_ID, repo: 'acme/app' } : null);
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
    signInAgent: () => Promise.reject(new Error('Unexpected agent OAuth login')),
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

function enable(token = 'human-jwt'): Request {
  return new Request('http://localhost/functions/v1/agent-admin', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
Deno.test('enable_platform_agent: an agent principal gets 403 humans_only before any check runs', async () => {
  const { deps, calls } = makeDeps();
  const res = await handleAgentAdmin(enable('agent-jwt'), deps);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'humans_only');
  assert.deepEqual(calls, []);
});
Deno.test('enable_platform_agent: an RPC failure deletes the auth user and returns 500', async () => {
  const { deps, calls } = makeDeps({ rpcFails: true });
  const res = await handleAgentAdmin(enable(), deps);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'server_error');
  assert.deepEqual(calls.map((c) => c.op), ['isWorkspaceOwner', 'getPlatformAgent', 'createUser', 'updateUserById', 'serviceRpc', 'deleteUser']);
  assert.equal(calls[calls.length - 1].args[0], AUTH_USER);
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

function ciConnect(): Request {
  return new Request('http://localhost/functions/v1/agent-admin', {
    method: 'POST', headers: { Authorization: 'Bearer human-jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ci_connect', workspace_id: WORKSPACE, repo: 'Acme/App' }),
  });
}

Deno.test('rotate_login prepares its exact password immediately before the Auth update and fails closed', async () => {
  for (const markerFails of [false, true]) {
    const { deps, calls } = makeDeps();
    const api = deps.caller('human-jwt');
    api.getAgent = async () => ({ id: AGENT_ID, workspace_id: WORKSPACE, auth_user_id: AUTH_USER, connection: { harness: 'codex' } });
    deps.caller = () => api;
    deps.serviceRpc = async (fn, args) => {
      calls.push({ op: 'serviceRpc', args: [fn, args] });
      if (markerFails) throw new Error('rotation unavailable');
      return null;
    };
    const res = await handleAgentAdmin(new Request('http://localhost/functions/v1/agent-admin', {
      method: 'POST', headers: { Authorization: 'Bearer human-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rotate_login', agent_id: AGENT_ID }),
    }), deps);
    assert.equal(res.status, markerFails ? 500 : 200);
    const password = await agentLoginPassword(PEPPER, AUTH_USER, 'temporary-secret');
    assert.deepEqual(calls, [
      { op: 'callerRpc', args: ['update_agent', { p_agent_id: AGENT_ID, p_patch: { connection: { harness: 'codex', login_nonce: 'temporary-secret' } } }] },
      { op: 'serviceRpc', args: ['prepare_agent_login_rotation', { p_auth_user_id: AUTH_USER, p_password: password }] },
      ...(markerFails ? [] : [{ op: 'updateUserById', args: [AUTH_USER, { password }] }]),
    ]);
  }
});

Deno.test('ci_connect authorizes as the caller and derives the connection secret without admin writes', async () => {
  const { deps, calls } = makeDeps();
  deps.loginPepper = '';
  const response = await handleAgentAdmin(ciConnect(), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: AGENT_ID, repo: 'acme/app',
    webhook_url: `https://api.test/functions/v1/github-webhook/${AGENT_ID}`,
    secret: await hmacSha256Hex('ci-pepper', `github-webhook:${AGENT_ID}`) });
  assert.deepEqual(calls, [{ op: 'callerRpc', args: ['create_ci_connection', { p_workspace_id: WORKSPACE, p_repo: 'Acme/App' }] }]);
});
Deno.test('ci_connect requires its pepper and propagates caller authorization failures', async () => {
  const { deps, calls } = makeDeps();
  deps.ciPepper = '';
  assert.equal((await handleAgentAdmin(ciConnect(), deps)).status, 500);
  assert.equal(calls.length, 0);
  deps.ciPepper = 'ci-pepper';
  const api = deps.caller('human-jwt');
  api.rpc = () => Promise.reject({ code: 'PT403', message: 'forbidden' });
  deps.caller = () => api;
  assert.equal((await handleAgentAdmin(ciConnect(), deps)).status, 403);
});

Deno.test('every admin action rejects an OAuth chat before any privileged operation', async () => {
  for (const action of ['create_agent', 'rotate_login', 'revoke_agent', 'enable_platform_agent', 'ci_connect', 'oauth_read', 'oauth_approve', 'oauth_deny', 'oauth_disconnect']) {
    const { deps, calls } = makeDeps();
    deps.verifyCaller = async () => ({ userId: HUMAN, principalType: 'human', clientId: 'chat-client' });
    const res = await handleAgentAdmin(new Request('http://localhost/functions/v1/agent-admin', {
      method: 'POST', headers: { Authorization: 'Bearer chat-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, workspace_id: WORKSPACE, agent_id: AGENT_ID, name: 'Chat-created', kind: 'mcp_client', repo: 'acme/app' }),
    }), deps);
    assert.equal(res.status, 403, action);
    assert.equal((await res.json()).error, 'direct_session_required', action);
    assert.deepEqual(calls, [], action);
  }
});

Deno.test('OAuth read and decisions use only the selected agent login and persist app metadata', async () => {
  for (const action of ['oauth_read', 'oauth_approve', 'oauth_deny', 'oauth_disconnect']) {
    const { deps, calls } = makeDeps();
    const api = deps.caller('human-jwt');
    api.rpc = async (fn, args) => {
      calls.push({ op: fn, args: [args] });
      return fn === 'oauth_agent_context' ? { agent_id: AGENT_ID, auth_user_id: AUTH_USER, login_nonce: 'rotated', link_revoked: false } : {};
    };
    deps.caller = () => api;
    deps.serviceRpc = async () => ({ client_id: 'client', client_name: 'App', redirect_uri: 'cursor://cb', user_id: AUTH_USER });
    const login: string[][] = [];
    deps.signInAgent = async (email, password) => {
      login.push([email, password]);
      return { read: async () => ({ client: { id: 'client', name: 'App' }, redirect_uri: 'cursor://cb', user: { email: 'agent@test.local' } }),
        approve: async () => ({ redirect_url: 'cursor://cb?code=secret-code' }), deny: async () => ({ redirect_url: 'cursor://cb?error=access_denied' }),
        disconnect: async () => { calls.push({ op: 'revokeGrant', args: [] }); } };
    };
    const res = await handleAgentAdmin(new Request('http://localhost/functions/v1/agent-admin', {
      method: 'POST', headers: { Authorization: 'Bearer human-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, agent_id: AGENT_ID, authorization_id: 'authz', client_id: 'client' }),
    }), deps);
    assert.equal(res.status, 200, action);
    assert.deepEqual(login, [[`agent+${AGENT_ID}@agents.invalid`, await agentLoginPassword(PEPPER, AUTH_USER, 'rotated')]]);
    assert.equal(calls[0].op, 'oauth_agent_context');
    if (action === 'oauth_approve') assert.ok(calls.some((c) => c.op === 'set_oauth_app'));
    if (action === 'oauth_disconnect') assert.ok(calls.findIndex((c) => c.op === 'revoke_oauth_link') < calls.findIndex((c) => c.op === 'revokeGrant'));
    const text = await res.text(); assert.ok(!text.includes('access_token')); assert.ok(!text.includes('rotated'));
  }
});

Deno.test('OAuth remembered consent records its link before returning and rejected contexts never log in', async () => {
  const { deps, calls } = makeDeps();
  const api = deps.caller('human-jwt');
  let allowed = false, persisted = false, logins = 0, saveFails = false;
  api.rpc = async (fn) => {
    if (!allowed) throw { code: 'PT403', message: 'forbidden' };
    if (fn === 'set_oauth_app') {
      if (saveFails) throw { code: 'PT403', message: 'forbidden' };
      persisted = true; return {};
    }
    return { agent_id: AGENT_ID, auth_user_id: AUTH_USER, link_revoked: false };
  };
  deps.caller = () => api;
  deps.serviceRpc = async () => ({ client_id: 'c', client_name: 'App', redirect_uri: 'https://app.test/cb', user_id: null });
  deps.signInAgent = async () => {
    logins++;
    return { read: async () => ({ redirect_url: 'https://app.test/cb?code=remembered' }), approve: async () => ({}), deny: async () => ({}), disconnect: async () => {} };
  };
  const req = () => new Request('http://localhost/functions/v1/agent-admin', { method: 'POST', headers: { Authorization: 'Bearer human-jwt' },
    body: JSON.stringify({ action: 'oauth_read', agent_id: AGENT_ID, authorization_id: 'authz' }) });
  assert.equal((await handleAgentAdmin(req(), deps)).status, 403); assert.equal(logins, 0); assert.deepEqual(calls, []);
  allowed = true;
  const res = await handleAgentAdmin(req(), deps);
  assert.equal(res.status, 200); assert.equal(persisted, true);
  assert.deepEqual(await res.json(), { redirect_url: 'https://app.test/cb?code=remembered' });
  saveFails = true;
  const refused = await handleAgentAdmin(req(), deps);
  assert.equal(refused.status, 403);
  assert.ok(!(await refused.text()).includes('remembered'));
});
