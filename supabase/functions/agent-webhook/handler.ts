// Pure handler for agent-webhook: the inbound side for webhook agents. An agent that received a CloudEvent from
// agent-dispatch answers here with {op, args}, using its own access token (the same gate as mcp). Each op runs the
// matching MCP task tool, so validation, RPC calls and errors are identical to the MCP path.
import type { Db } from '../_shared/db.ts';
import { ToolError } from '../_shared/db.ts';
import { jsonResponse, oauthError } from '../_shared/errors.ts';
import { validate } from '../_shared/jsonSchema.ts';
import { AuthError, type VerifiedBearer } from '../_shared/jwt.ts';
import { defaultSleep, type ToolContext, type ToolDef } from '../_shared/mcp.ts';

export interface WebhookDeps {
  verify(req: Request): Promise<VerifiedBearer>;
  makeDb(token: string, signal: AbortSignal): Db;
  /** The ops this endpoint accepts: the MCP task tools. */
  tools: ToolDef[];
  appUrl: string;
  now?(): number;
  budgetMs?: number;
}

const MAX_BODY_BYTES = 1024 * 1024;

const STATUS_BY_CODE: Record<string, number> = {
  invalid_input: 400,
  budget_exceeded: 402,
  forbidden: 403,
  agent_disabled: 403,
  humans_only: 403,
  lead_only: 403,
  direct_session_required: 403,
  not_found: 404,
  run_active: 409,
  run_not_active: 409,
  task_unavailable: 409,
  task_closed: 409,
  block_conflict: 409,
  conflict: 409,
  approval_consumed: 409,
  approval_mismatch: 409,
  approval_expired: 410,
  receipt_expired: 410,
  rate_limited: 429,
  internal: 500,
  timeout: 504,
};

export function statusFor(code: string): number {
  return STATUS_BY_CODE[code] ?? 422;
}

export async function handleAgentWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'Use POST.', { Allow: 'POST' });

  let bearer: VerifiedBearer;
  try {
    bearer = await deps.verify(req);
  } catch (err) {
    if (err instanceof AuthError) {
      return err.status === 401
        ? oauthError(401, err.code, err.message, { 'WWW-Authenticate': 'Bearer realm="workspace", error="invalid_token"' })
        : oauthError(403, err.code, err.message);
    }
    return oauthError(500, 'server_error', 'Token validation failed.');
  }
  if (bearer.principal.type !== 'agent') {
    return oauthError(403, 'wrong_principal', 'Only agent tokens can call this endpoint.');
  }

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return oauthError(413, 'payload_too_large', 'The body exceeds 1 MiB.');
  let body: { op?: unknown; args?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return oauthError(400, 'invalid_request', 'Body must be JSON: {"op": "<tool>", "args": {...}}.');
  }
  const tool = deps.tools.find((t) => t.name === body?.op);
  if (!tool) {
    return jsonResponse(400, {
      error: 'unknown_op',
      error_description: `Unknown op. Accepted: ${deps.tools.map((t) => t.name).join(', ')}.`,
    });
  }
  const args = { ...((body.args ?? {}) as Record<string, unknown>) };
  if (typeof body.args !== 'undefined' && (typeof body.args !== 'object' || body.args === null || Array.isArray(body.args))) {
    return oauthError(400, 'invalid_request', 'args must be an object.');
  }

  // Idempotency-Key header -> the tool's own idempotency key, when it has one.
  const key = req.headers.get('Idempotency-Key');
  if (key && tool.inputSchema.properties?.idempotency_key && args.idempotency_key === undefined) args.idempotency_key = key;

  const errors = validate(tool.inputSchema, args);
  if (errors.length) return jsonResponse(400, { error: 'invalid_params', error_description: errors.slice(0, 5).join('; '), errors });

  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(tool.budgetMs?.(args) ?? deps.budgetMs ?? 20_000)]);
  const ctx: ToolContext = {
    db: deps.makeDb(bearer.token, signal),
    principal: bearer.principal,
    signal,
    appUrl: deps.appUrl,
    now: deps.now ?? (() => Date.now()),
    sleep: defaultSleep,
    progress: () => {},
  };
  try {
    const out = await tool.handler(args, ctx);
    return jsonResponse(200, { ok: true, op: tool.name, summary: out.text, result: out.structured });
  } catch (err) {
    if (err instanceof ToolError) {
      return jsonResponse(statusFor(err.code), { ok: false, op: tool.name, error: err.code, error_description: err.message, detail: err.detail ?? null });
    }
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    return oauthError(500, 'server_error', 'The operation failed.');
  }
}
