import assert from 'node:assert/strict';
import { buildServer } from '../mcp/server.ts';
import { type Db, ToolError } from './db.ts';
import { AuthError, type VerifiedBearer } from './jwt.ts';
import { handleMcp, MAX_BATCH, type McpDeps, type McpServer } from './mcp.ts';

const ENV = {
  SUPABASE_URL: 'http://project.test',
  MCP_ALLOWED_ORIGINS: 'https://app.example',
  MCP_RESOURCE_URL: 'http://project.test/functions/v1/mcp',
};

const BEARER: VerifiedBearer = {
  token: 'jwt',
  claims: {},
  principal: { type: 'agent', userId: 'u1', agentId: 'a1', workspaceId: 'w1', clientId: null },
};

const fakeDb: Db = {
    download: async () => ({ data: null, error: null }),
  rpc: () => Promise.resolve({ data: null, error: null }),
  select: () => Promise.resolve({ data: [], error: null }),
};

const server: McpServer = {
  name: 'test',
  title: 'Test',
  version: '0.0.0',
  instructions: 'Be nice.',
  tools: [
    {
      name: 'echo',
      title: 'Echo',
      description: 'Echoes text.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      cacheTtlMs: 30_000,
      handler: (args) => Promise.resolve({ text: `Echo ${String(args.text)}`, structured: { text: args.text } }),
    },
    {
      name: 'conflict',
      title: 'Conflict',
      description: 'Always conflicts.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      handler: () => Promise.reject(new ToolError('block_conflict', 'changed', { block_id: 'c3', text: 'Leads 2025' })),
    },
  ],
  prompts: [],
  resources: { templates: [], list: () => Promise.resolve([]), read: () => Promise.resolve(null) },
};

function deps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    env: ENV,
    verify: () => Promise.resolve(BEARER),
    makeDb: () => fakeDb,
    log: () => {},
    randomId: () => 'session-1',
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}, raw?: string): Request {
  return new Request('http://localhost/functions/v1/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer jwt', ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

async function call(req: Request, srv = server, d = deps()) {
  const res = await handleMcp(req, srv, d);
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

Deno.test('parse error is -32700', async () => {
  const { body } = await call(post(null, {}, '{"jsonrpc":'));
  assert.equal(body.error.code, -32700);
  assert.equal(body.id, null);
});

Deno.test(`batch over ${MAX_BATCH} messages is -32600; a valid batch answers each request`, async () => {
  const msgs = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
  const big = await call(post(msgs));
  assert.equal(big.body.error.code, -32600);
  const ok = await call(post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]));
  assert.equal(ok.body.length, 1);
  assert.deepEqual(ok.body[0], { jsonrpc: '2.0', id: 1, result: {} });
});

Deno.test('unknown method is -32601', async () => {
  const { body } = await call(post({ jsonrpc: '2.0', id: 3, method: 'tasks/frobnicate' }));
  assert.equal(body.error.code, -32601);
  const sub = await call(post({ jsonrpc: '2.0', id: 4, method: 'subscriptions/listen' }));
  assert.equal(sub.body.error.code, -32601);
  assert.match(sub.body.error.message, /poll list_my_tasks/);
});

Deno.test('arguments that break the tool schema are -32602', async () => {
  const { body } = await call(post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { text: 42 } } }));
  assert.equal(body.error.code, -32602);
  const unknownTool = await call(post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } }));
  assert.equal(unknownTool.body.error.code, -32602);
});

Deno.test('2025 era initialize issues an Mcp-Session-Id and negotiates the version', async () => {
  const { res, body } = await call(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } }));
  assert.equal(res.headers.get('Mcp-Session-Id'), 'session-1');
  assert.equal(body.result.protocolVersion, '2025-03-26');
  assert.equal(body.result.instructions, 'Be nice.');
  assert.deepEqual(Object.keys(body.result.capabilities).sort(), ['prompts', 'resources', 'tools']);
  const old = await call(post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } }));
  assert.equal(old.body.result.protocolVersion, '2025-06-18');
  const note = await handleMcp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), server, deps());
  assert.equal(note.status, 202);
});

Deno.test('2026 era: server/discover, resultType, cacheable tool results, no batches', async () => {
  const h = { 'MCP-Protocol-Version': '2026-07-28' };
  const discover = await call(post({ jsonrpc: '2.0', id: 1, method: 'server/discover' }, h));
  assert.equal(discover.body.result.resultType, 'server/discover');
  assert.equal(discover.body.result.tools.length, 2);
  const tool = await call(post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }, h));
  assert.equal(tool.body.result.resultType, 'tools/call');
  assert.equal(tool.body.result.ttlMs, 30_000);
  assert.equal(tool.body.result.cacheScope, 'session');
  const batch = await call(post([{ jsonrpc: '2.0', id: 1, method: 'ping' }], h));
  assert.equal(batch.body.error.code, -32600);
  const bad = await handleMcp(post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' }), server, deps());
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'unsupported_protocol_version');
});

Deno.test('Origin outside the allowlist is 403; allowed origin gets CORS', async () => {
  const res = await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' }), server, deps());
  assert.equal(res.status, 403);
  await res.body?.cancel();
  const ok = await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://app.example' }), server, deps());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  await ok.body?.cancel();
});

Deno.test('Mcp-Method or Mcp-Name different from the body is 400', async () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } };
  const res = await handleMcp(post(msg, { 'Mcp-Method': 'tools/list' }), server, deps());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.message, 'header_body_mismatch');
  const name = await handleMcp(post(msg, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'conflict' }), server, deps());
  assert.equal(name.status, 400);
  await name.body?.cancel();
  const same = await handleMcp(post(msg, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' }), server, deps());
  assert.equal(same.status, 200);
  await same.body?.cancel();
});

Deno.test('no bearer: 401 with WWW-Authenticate pointing at the protected-resource metadata', async () => {
  const d = deps({ verify: () => Promise.reject(new AuthError(401, 'invalid_token', 'Missing bearer token.')) });
  const res = await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'ping' }), server, d);
  assert.equal(res.status, 401);
  const header = res.headers.get('WWW-Authenticate') ?? '';
  assert.match(header, /^Bearer realm="workspace"/);
  assert.match(header, /resource_metadata="http:\/\/project\.test\/functions\/v1\/mcp\/\.well-known\/oauth-protected-resource"/);
  assert.match(header, /error="invalid_token"/);
  await res.body?.cancel();
  const wrong = await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'ping' }), server,
    deps({ verify: () => Promise.reject(new AuthError(403, 'wrong_principal', 'no')) }));
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'wrong_principal');
});

Deno.test('GET serves the PRM on the well-known path and 405 elsewhere', async () => {
  const prm = await handleMcp(new Request('http://localhost/functions/v1/mcp/.well-known/oauth-protected-resource'), server, deps());
  const body = await prm.json();
  assert.equal(body.resource, 'http://project.test/functions/v1/mcp');
  assert.deepEqual(body.authorization_servers, ['http://project.test/auth/v1']);
  assert.deepEqual(body.bearer_methods_supported, ['header']);
  const get = await handleMcp(new Request('http://localhost/functions/v1/mcp'), server, deps());
  assert.equal(get.status, 405);
  await get.body?.cancel();
});

Deno.test('domain errors come back as isError results, not JSON-RPC errors', async () => {
  const { body } = await call(post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'conflict', arguments: {} } }));
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.code, 'block_conflict');
  assert.equal(body.result.structuredContent.detail.block_id, 'c3');
  assert.match(body.result.content[0].text, /Its text is now: "Leads 2025"/);
});

Deno.test('every real tool has a title, hints and an output schema; $defs are always inlined', async () => {
  const real = buildServer();
  assert.ok(real.instructions.length <= 1500);
  const { body } = await call(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), real);
  for (const tool of body.result.tools) {
    assert.ok(tool.title, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.equal(typeof tool.annotations.destructiveHint, 'boolean', tool.name);
    assert.equal(typeof tool.annotations.idempotentHint, 'boolean', tool.name);
    assert.equal(tool.outputSchema.type, 'object', tool.name);
  }
  const append = body.result.tools.find((t: { name: string }) => t.name === 'append_blocks');
  assert.doesNotMatch(JSON.stringify(append.inputSchema), /\$ref|\$defs/);
  assert.match(JSON.stringify(append.inputSchema), /"spans"/);
  const fromChatGpt = await call(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'User-Agent': 'openai-mcp/1.0' }), real);
  assert.deepEqual(fromChatGpt.body.result.tools, body.result.tools);
  const prompts = await call(post({ jsonrpc: '2.0', id: 3, method: 'prompts/list' }), real);
  assert.deepEqual(prompts.body.result.prompts.map((p: { name: string }) => p.name), ['continue_task', 'review_as_lead', 'review_delivery']);
});

Deno.test('a denied agent call is recorded for the metrics, best effort; other errors and people are not', async () => {
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  const db: Db = {
    download: async () => ({ data: null, error: null }),
    rpc: <T>(fn: string, params: Record<string, unknown>) => {
      calls.push({ fn, params });
      return Promise.resolve({ data: null as T, error: null });
    },
    select: () => Promise.resolve({ data: [], error: null }),
  };
  let denialCode = 'forbidden';
  const deny = { ...server.tools[1], name: 'deny', handler: () => Promise.reject(new ToolError(denialCode, 'no')) };
  const srv: McpServer = { ...server, tools: [...server.tools, deny] };
  const taskId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const callDeny = (args: Record<string, unknown>) => post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deny', arguments: args } });

  const denied = await call(callDeny({ task_id: taskId }), srv, deps({ makeDb: () => db }));
  assert.equal(denied.body.result.isError, true);
  assert.deepEqual(calls, [{ fn: 'record_access_denial', params: { p_tool: 'deny', p_code: 'forbidden', p_task_id: taskId } }]);

  for (const code of ['humans_only', 'lead_only', 'direct_session_required']) {
    denialCode = code;
    calls.length = 0;
    await call(callDeny({ task_id: taskId }), srv, deps({ makeDb: () => db }));
    assert.deepEqual(calls.map((c) => c.params.p_code), [code]);
  }
  denialCode = 'forbidden';
  calls.length = 0;
  await call(callDeny({ task_id: 'not-a-uuid' }), srv, deps({ makeDb: () => db }));
  assert.deepEqual(calls.map((c) => c.params.p_task_id), [null]);

  calls.length = 0;
  await call(post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'conflict', arguments: {} } }), srv, deps({ makeDb: () => db }));
  const human: VerifiedBearer = { ...BEARER, principal: { ...BEARER.principal, type: 'human', agentId: null } };
  await call(callDeny({}), srv, deps({ makeDb: () => db, verify: () => Promise.resolve(human) }));
  for (const code of ['waiting_on_human', 'invalid_input']) {
    denialCode = code;
    await call(callDeny({}), srv, deps({ makeDb: () => db }));
  }
  assert.deepEqual(calls, []);
  denialCode = 'forbidden';

  const down: Db = { ...db, rpc: () => Promise.reject(new Error('down')) };
  const still = await call(callDeny({}), srv, deps({ makeDb: () => down }));
  assert.deepEqual(still.body.result, denied.body.result);
});

Deno.test('a stalled denial log times out without changing the original denial', async () => {
  const parent = new AbortController();
  const watchdog = setTimeout(() => parent.abort(), 3_000);
  let logAborted = false;
  const deny = { ...server.tools[1], name: 'deny', handler: () => Promise.reject(new ToolError('forbidden', 'no')) };
  const req = new Request(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deny' } }), { signal: parent.signal });
  try {
    const result = await call(req, { ...server, tools: [deny] }, deps({ makeDb: (_token, signal) => ({
      ...fakeDb,
      rpc: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { logAborted = true; reject(signal.reason); }, { once: true });
      }),
    }) }));
    assert.equal(logAborted, true);
    assert.equal(parent.signal.aborted, false);
    assert.deepEqual(result.body.result.structuredContent, { code: 'forbidden', message: 'no', detail: null });
  } finally {
    clearTimeout(watchdog);
  }
});
