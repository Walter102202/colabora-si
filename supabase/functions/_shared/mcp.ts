// Remote MCP server over a single POST-only HTTP endpoint (Streamable HTTP, JSON responses only, no SSE).
// One dispatch(method, params, era) serves both protocol eras: "2025" (initialize + stateless Mcp-Session-Id)
// and "2026" (2026-07-28: server/discover, resultType, cacheable results). No session state is kept.
import type { Db } from './db.ts';
import { messageFor, ToolError } from './db.ts';
import { jsonResponse, oauthError } from './errors.ts';
import { inlineRefs, type JsonSchema, validate } from './jsonSchema.ts';
import { AuthError, type Principal, type VerifiedBearer } from './jwt.ts';
import type { Env } from './supabase.ts';

export const SUPPORTED_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'] as const;
export const ERA_2026 = '2026-07-28';
export const DEFAULT_VERSION = '2025-06-18';
export const MAX_BATCH = 10;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_TEXT_CHARS = 100_000;
export const DEFAULT_TOOL_BUDGET_MS = 20_000;
const PRM_SUFFIX = '/.well-known/oauth-protected-resource';

export type Era = '2025' | '2026';

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface ToolContext {
  db: Db;
  principal: Principal;
  signal: AbortSignal;
  appUrl: string;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** notifications/progress when the client sent a progressToken. JSON responses cannot carry it mid-call, so it is a no-op here. */
  progress(progress: number, total?: number, message?: string): void;
}

export interface ToolOutput {
  /** One-line, human-readable summary; the JSON of `structured` is appended as the text mirror. */
  text: string;
  structured: Record<string, unknown>;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: ToolAnnotations;
  /** 2026 era CacheableResult.ttlMs; 0 for writes. */
  cacheTtlMs?: number;
  /** Time budget of one call; the default is 20 s. */
  budgetMs?(args: Record<string, unknown>): number;
  /** Tool metadata, e.g. the MCP Apps card that renders the result ({ui: {resourceUri}}). */
  _meta?: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  get(args: Record<string, string>, ctx: ToolContext): Promise<{ description: string; messages: unknown[] }>;
}

export interface ResourceEntry {
  uri: string;
  name: string;
  title?: string;
  mimeType: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
  _meta?: Record<string, unknown>;
}

export interface ResourceProvider {
  list(ctx: ToolContext): Promise<ResourceEntry[]>;
  templates: { uriTemplate: string; name: string; title: string; mimeType: string; description: string }[];
  /** null when the uri is unknown or unreadable. */
  read(uri: string, ctx: ToolContext): Promise<ResourceContent | null>;
}

export interface McpServer {
  name: string;
  title: string;
  version: string;
  instructions: string;
  tools: ToolDef[];
  prompts: PromptDef[];
  resources: ResourceProvider;
}

export interface McpDeps {
  env: Env;
  verify(req: Request): Promise<VerifiedBearer>;
  makeDb(token: string, signal: AbortSignal): Db;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  log?(line: Record<string, unknown>): void;
  randomId?(): string;
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

type Id = string | number | null;

interface RpcRequest {
  jsonrpc: '2.0';
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

const rpcError = (id: Id, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : DEFAULT_VERSION;
}

export function describeTool(tool: ToolDef) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inlineRefs(tool.inputSchema),
    outputSchema: inlineRefs(tool.outputSchema),
    annotations: { title: tool.title, openWorldHint: false, ...tool.annotations },
    ...(tool._meta ? { _meta: tool._meta } : {}),
  };
}

function capabilities() {
  return {
    tools: { listChanged: false },
    prompts: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
  };
}

function capText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 40)}\n… [truncated: result too long]` : text;
}

export function toolResult(out: ToolOutput) {
  return {
    content: [{ type: 'text', text: capText(`${out.text}\n\n${JSON.stringify(out.structured)}`) }],
    structuredContent: out.structured,
  };
}

export function toolErrorResult(err: ToolError) {
  const structured = { code: err.code, message: err.message, detail: err.detail ?? null };
  let text = `Error ${err.code}: ${err.message}`;
  const detail = err.detail as Record<string, unknown> | null;
  if (err.code === 'block_conflict' && detail && typeof detail === 'object' && typeof detail.text === 'string') {
    text = `Block ${String(detail.block_id ?? '')} changed since you read it. Its text is now: "${detail.text}". ` +
      'Re-read the page or retry with the current text.';
  }
  return {
    isError: true,
    content: [{ type: 'text', text: capText(`${text}\n\n${JSON.stringify(structured)}`) }],
    structuredContent: structured,
  };
}

function abortAfter(ms: number, parent: AbortSignal): { signal: AbortSignal; clear(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(new DOMException('timeout', 'TimeoutError'));
  }, ms);
  const onParent = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onParent, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parent.removeEventListener('abort', onParent);
    },
    timedOut: () => fired,
  };
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface RequestState {
  server: McpServer;
  deps: McpDeps;
  bearer: VerifiedBearer;
  era: Era;
  signal: AbortSignal;
  appUrl: string;
  /** Filled for the log line. */
  tool?: string;
  code?: string;
}

function makeContext(state: RequestState, signal: AbortSignal): ToolContext {
  const { deps } = state;
  return {
    db: deps.makeDb(state.bearer.token, signal),
    principal: state.bearer.principal,
    signal,
    appUrl: state.appUrl,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? defaultSleep,
    progress: () => {},
  };
}

async function callTool(state: RequestState, params: Record<string, unknown>) {
  const name = params.name;
  const tool = state.server.tools.find((t) => t.name === name);
  if (typeof name !== 'string' || !tool) throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
  state.tool = tool.name;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new RpcError(-32602, 'arguments must be an object');
  }
  const errors = validate(tool.inputSchema, args);
  if (errors.length) throw new RpcError(-32602, `Invalid arguments for ${tool.name}: ${errors.slice(0, 5).join('; ')}`, { errors });

  const budget = abortAfter(tool.budgetMs?.(args) ?? DEFAULT_TOOL_BUDGET_MS, state.signal);
  try {
    const out = await tool.handler(args, makeContext(state, budget.signal));
    state.code = 'ok';
    const result: Record<string, unknown> = toolResult(out);
    if (state.era === '2026') {
      result.ttlMs = tool.cacheTtlMs ?? 0;
      result.cacheScope = 'session';
    }
    return result;
  } catch (err) {
    let toolErr: ToolError | null = err instanceof ToolError ? err : null;
    if (!toolErr && budget.timedOut()) toolErr = new ToolError('timeout', messageFor('timeout'));
    if (toolErr) {
      if (budget.timedOut() && toolErr.code !== 'timeout') toolErr = new ToolError('timeout', messageFor('timeout'));
      state.code = toolErr.code;
      return toolErrorResult(toolErr);
    }
    throw err;
  } finally {
    budget.clear();
  }
}

async function dispatch(state: RequestState, method: string, params: Record<string, unknown>): Promise<unknown> {
  const { server } = state;
  const ctx = () => makeContext(state, state.signal);
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: capabilities(),
        serverInfo: { name: server.name, title: server.title, version: server.version },
        instructions: server.instructions,
      };
    case 'server/discover':
      if (state.era !== '2026') break;
      return {
        protocolVersion: ERA_2026,
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: capabilities(),
        serverInfo: { name: server.name, title: server.title, version: server.version },
        instructions: server.instructions,
        tools: server.tools.map((t) => describeTool(t)),
      };
    case 'ping':
      return {};
    case 'logging/setLevel':
      return {};
    case 'tools/list':
      return { tools: server.tools.map((t) => describeTool(t)) };
    case 'tools/call':
      return await callTool(state, params);
    case 'prompts/list':
      return {
        prompts: server.prompts.map(({ name, title, description, arguments: args }) => ({
          name,
          title,
          description,
          arguments: args,
        })),
      };
    case 'prompts/get': {
      const prompt = server.prompts.find((p) => p.name === params.name);
      if (!prompt) throw new RpcError(-32602, `Unknown prompt: ${String(params.name)}`);
      const args = (params.arguments ?? {}) as Record<string, string>;
      for (const a of prompt.arguments) {
        if (a.required && (typeof args[a.name] !== 'string' || !args[a.name])) {
          throw new RpcError(-32602, `Missing prompt argument: ${a.name}`);
        }
      }
      try {
        return await prompt.get(args, ctx());
      } catch (err) {
        if (err instanceof ToolError) throw new RpcError(-32602, `${err.code}: ${err.message}`);
        throw err;
      }
    }
    case 'resources/list':
      return { resources: await server.resources.list(ctx()) };
    case 'resources/templates/list':
      return { resourceTemplates: server.resources.templates };
    case 'resources/read': {
      if (typeof params.uri !== 'string') throw new RpcError(-32602, 'uri is required');
      let content: Awaited<ReturnType<ResourceProvider['read']>> = null;
      try {
        content = await server.resources.read(params.uri, ctx());
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
      }
      if (!content) throw new RpcError(-32002, `Resource not found: ${params.uri}`);
      return { contents: [content] };
    }
    case 'subscriptions/listen':
      throw new RpcError(-32601, 'subscriptions not supported; poll list_my_tasks');
  }
  throw new RpcError(-32601, `Method not found: ${method}`);
}

function isRequestShape(msg: unknown): msg is RpcRequest {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return false;
  if ('id' in m && !(typeof m.id === 'string' || typeof m.id === 'number' || m.id === null)) return false;
  if ('params' in m && (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params))) return false;
  return true;
}

/** One message: a response object, or null for notifications and client responses. */
async function handleMessage(state: RequestState, msg: unknown): Promise<Record<string, unknown> | null> {
  if (typeof msg === 'object' && msg !== null && !Array.isArray(msg) && !('method' in msg) &&
    ('result' in msg || 'error' in msg)) {
    return null; // a client response (e.g. to a ping): nothing to answer
  }
  if (!isRequestShape(msg)) {
    const id = (typeof msg === 'object' && msg !== null && 'id' in msg) ? (msg as { id: Id }).id ?? null : null;
    return rpcError(id, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in msg);
  if (isNotification) return null;
  const id = msg.id ?? null;
  const meta = (msg.params?._meta ?? null) as Record<string, unknown> | null;
  if (meta?.progressToken !== undefined || meta?.['io.modelcontextprotocol/request-id'] !== undefined) {
    state.deps.log?.({ rid: id, progressToken: meta?.progressToken ?? null, meta_request_id: meta?.['io.modelcontextprotocol/request-id'] ?? null });
  }
  try {
    const result = await dispatch(state, msg.method, msg.params ?? {});
    if (state.era === '2026' && result && typeof result === 'object') {
      (result as Record<string, unknown>).resultType = msg.method;
    }
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (err instanceof RpcError) {
      state.code = String(err.code);
      return rpcError(id, err.code, err.message, err.data);
    }
    state.code = '-32603';
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    return rpcError(id, -32603, 'Internal error');
  }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function allowedOrigins(env: Env): string[] {
  return (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    'Vary': 'Origin',
  };
}

export function resourceUrl(req: Request, env: Env): string {
  if (env.MCP_RESOURCE_URL) return env.MCP_RESOURCE_URL.replace(/\/+$/, '');
  const url = new URL(req.url);
  const path = url.pathname.endsWith(PRM_SUFFIX) ? url.pathname.slice(0, -PRM_SUFFIX.length) : url.pathname;
  return `${url.origin}${path.replace(/\/+$/, '')}`;
}

export function protectedResourceMetadata(req: Request, env: Env) {
  const issuer = env.MCP_AUTH_SERVER_URL || `${(env.SUPABASE_URL ?? '').replace(/\/+$/, '')}/auth/v1`;
  const body: Record<string, unknown> = {
    resource: resourceUrl(req, env),
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [],
  };
  if (env.APP_URL) body.resource_documentation = `${env.APP_URL.replace(/\/+$/, '')}/docs/mcp`;
  return body;
}

function unauthorized(req: Request, env: Env, err: AuthError, cors: Record<string, string>): Response {
  if (err.status === 403) return oauthError(403, err.code, err.message, cors);
  const prm = `${resourceUrl(req, env)}${PRM_SUFFIX}`;
  const description = err.message.replace(/"/g, "'");
  return oauthError(401, 'invalid_token', err.message, {
    ...cors,
    'WWW-Authenticate':
      `Bearer realm="workspace", resource_metadata="${prm}", error="invalid_token", error_description="${description}"`,
  });
}

/** Handles one HTTP request to the mcp function. */
export async function handleMcp(req: Request, server: McpServer, deps: McpDeps): Promise<Response> {
  const started = deps.now?.() ?? Date.now();
  const env = deps.env;
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin, env);
  const url = new URL(req.url);
  const log = deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));

  if (origin && !allowedOrigins(env).includes(origin)) {
    return oauthError(403, 'forbidden_origin', 'This origin is not allowed.');
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method === 'GET' && url.pathname.endsWith(PRM_SUFFIX)) {
    return jsonResponse(200, protectedResourceMetadata(req, env), cors);
  }
  if (req.method !== 'POST') {
    return oauthError(405, 'method_not_allowed', 'This endpoint accepts POST only.', { ...cors, Allow: 'POST, OPTIONS' });
  }

  const version = req.headers.get('MCP-Protocol-Version');
  if (version && !(SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
    return oauthError(400, 'unsupported_protocol_version', `Supported versions: ${SUPPORTED_VERSIONS.join(', ')}.`, cors);
  }
  const era: Era = version && version >= ERA_2026 ? '2026' : '2025';

  let bearer: VerifiedBearer;
  try {
    bearer = await deps.verify(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(req, env, err, cors);
    console.error(err);
    return oauthError(500, 'server_error', 'Token validation failed.', cors);
  }

  const contentType = req.headers.get('Content-Type') ?? '';
  if (!/application\/json/i.test(contentType)) {
    return oauthError(415, 'unsupported_media_type', 'Content-Type must be application/json.', cors);
  }
  const accept = req.headers.get('Accept');
  if (accept && !/application\/json|application\/\*|\*\/\*/i.test(accept)) {
    return oauthError(406, 'not_acceptable', 'Accept must include application/json.', cors);
  }
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) return oauthError(413, 'payload_too_large', 'The body exceeds 1 MiB.', cors);
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return oauthError(413, 'payload_too_large', 'The body exceeds 1 MiB.', cors);
  }

  const headers: Record<string, string> = { ...cors };
  const finish = (status: number, body: unknown, state?: RequestState, method?: string) => {
    log({
      rid: crypto.randomUUID(),
      method: method ?? null,
      tool: state?.tool ?? null,
      principal_type: bearer.principal.type,
      agent_id: bearer.principal.agentId,
      client_id: bearer.principal.clientId,
      ms: (deps.now?.() ?? Date.now()) - started,
      ok: status < 400 && !(state?.code && state.code !== 'ok'),
      code: state?.code ?? (status >= 400 ? String(status) : 'ok'),
    });
    if (body === null) return new Response(null, { status, headers });
    return jsonResponse(status, body, headers);
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return finish(400, rpcError(null, -32700, 'Parse error'));
  }

  const state: RequestState = {
    server,
    deps,
    bearer,
    era,
    signal: req.signal,
    appUrl: (env.APP_URL ?? '').replace(/\/+$/, ''),
  };

  const headerMethod = req.headers.get('Mcp-Method');
  const headerName = req.headers.get('Mcp-Name');
  if (headerMethod || headerName) {
    const single = Array.isArray(parsed) ? null : parsed as Record<string, unknown> | null;
    const bodyName = (single?.params as Record<string, unknown> | undefined)?.name;
    if (!single || (headerMethod && headerMethod !== single.method) || (headerName && headerName !== bodyName)) {
      return finish(400, rpcError((single?.id as Id) ?? null, -32600, 'header_body_mismatch'));
    }
  }

  if (Array.isArray(parsed)) {
    if (era === '2026') return finish(400, rpcError(null, -32600, 'Batches are not supported in this protocol version'));
    if (parsed.length === 0 || parsed.length > MAX_BATCH) {
      return finish(400, rpcError(null, -32600, `A batch must hold 1 to ${MAX_BATCH} messages`));
    }
    const responses: Record<string, unknown>[] = [];
    for (const msg of parsed) {
      const res = await handleMessage(state, msg);
      if (res) responses.push(res);
    }
    return responses.length ? finish(200, responses, state, 'batch') : finish(202, null, state, 'batch');
  }

  const method = (parsed as { method?: unknown } | null)?.method;
  const response = await handleMessage(state, parsed);
  if (!response) return finish(202, null, state, typeof method === 'string' ? method : undefined);
  if (method === 'initialize' && era === '2025' && !('error' in response)) {
    headers['Mcp-Session-Id'] = deps.randomId?.() ?? crypto.randomUUID();
  } else {
    const session = req.headers.get('Mcp-Session-Id');
    if (session) headers['Mcp-Session-Id'] = session;
  }
  const status = 'error' in response && (response.error as { code: number }).code === -32600 ? 400 : 200;
  return finish(status, response, state, typeof method === 'string' ? method : undefined);
}
