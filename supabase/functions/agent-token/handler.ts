// Pure handler for agent-token: exchanges a personal access token (agt_...) for a short-lived agent JWT.
// No Supabase imports here: index.ts wires the real clients through `deps`.
import { agentEmail, agentLoginPassword } from '../_shared/agentLogin.ts';
import { jsonResponse, oauthError } from '../_shared/errors.ts';
import { sha256Hex } from '../_shared/hmac.ts';

export interface TokenRow {
  agent_id: string;
  auth_user_id: string;
  workspace_id: string;
  scopes: string[];
  token_id: string;
}

export interface AgentTokenDeps {
  /** pepper from rpc('agent_token_config'). */
  getPepper(): Promise<string>;
  /** rpc('lookup_agent_token'); null when unknown, revoked or expired; throws {code: 'agent_disabled'} on PT403. */
  lookupToken(hash: string): Promise<TokenRow | null>;
  /** agents.connection.login_nonce, set by agent-admin rotate_login. */
  getLoginNonce?(agentId: string): Promise<string | null>;
  signIn(email: string, password: string): Promise<{ access_token: string; expires_in: number }>;
  loginPepper: string;
  now(): number;
  limiter?: FailureLimiter;
}

export const TOKEN_PATTERN = /^agt_[0-9A-Za-z]{40}$/;
export const MAX_FAILURES_PER_MINUTE = 20;
const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

/** In-memory sliding window of failed attempts per key (per isolate; the database rate limit is separate). */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly max = MAX_FAILURES_PER_MINUTE, private readonly windowMs = WINDOW_MS) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  /** Seconds until the key may try again, or 0 when it is not blocked. */
  retryAfter(key: string, now: number): number {
    const recent = this.recent(key, now);
    if (recent.length < this.max) return 0;
    return Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
  }

  recordFailure(key: string, now: number): void {
    if (this.failures.size >= MAX_TRACKED_KEYS) {
      for (const k of [...this.failures.keys()]) this.recent(k, now);
    }
    const recent = this.recent(key, now);
    recent.push(now);
    this.failures.set(key, recent);
  }
}

const sharedLimiter = new FailureLimiter();

function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown';
}

function isAgentDisabled(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'agent_disabled';
}

export async function handleAgentToken(req: Request, deps: AgentTokenDeps): Promise<Response> {
  if (req.method !== 'POST') {
    return oauthError(405, 'invalid_request', 'Use POST.', { Allow: 'POST' });
  }
  if (!deps.loginPepper) {
    return oauthError(500, 'misconfigured', 'AGENT_LOGIN_PEPPER is not set.');
  }

  let body: { token?: unknown; ttl_seconds?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const token = typeof body?.token === 'string' ? body.token : '';

  // Failures are counted per client IP and token prefix, so one bad caller cannot lock out another token.
  const limiter = deps.limiter ?? sharedLimiter;
  const now = deps.now();
  const key = `${clientIp(req)}|${token.slice(0, 8)}`;
  const retryAfter = limiter.retryAfter(key, now);
  if (retryAfter > 0) {
    return oauthError(429, 'rate_limited', 'Too many failed attempts. Try again later.', {
      'Retry-After': String(retryAfter),
    });
  }
  const fail = (status: number, code: string, description: string) => {
    limiter.recordFailure(key, now);
    return oauthError(status, code, description);
  };

  if (!TOKEN_PATTERN.test(token)) {
    return fail(400, 'invalid_request', 'Body must be {"token": "agt_<40 alphanumeric characters>"}.');
  }
  // The lifetime is the project's JWT expiry (at most 3600 s); ttl_seconds is validated but cannot extend it.
  const ttl = body?.ttl_seconds;
  if (ttl !== undefined && !(typeof ttl === 'number' && Number.isInteger(ttl) && ttl > 0)) {
    return fail(400, 'invalid_request', 'ttl_seconds must be a positive integer.');
  }

  let pepper = '';
  try {
    pepper = await deps.getPepper();
  } catch {
    pepper = '';
  }
  if (!pepper) return oauthError(500, 'misconfigured', 'The token pepper is not configured.');

  let row: TokenRow | null;
  try {
    row = await deps.lookupToken(await sha256Hex(pepper + token));
  } catch (err) {
    if (isAgentDisabled(err)) {
      return oauthError(403, 'agent_disabled', 'This agent is paused or agents are turned off.');
    }
    return oauthError(500, 'server_error', 'Token lookup failed.');
  }
  if (!row) {
    return fail(401, 'invalid_token', 'The token is unknown, revoked or expired.');
  }

  let session: { access_token: string; expires_in: number };
  try {
    const nonce = deps.getLoginNonce ? await deps.getLoginNonce(row.agent_id) : null;
    const password = await agentLoginPassword(deps.loginPepper, row.auth_user_id, nonce);
    session = await deps.signIn(agentEmail(row.agent_id), password);
  } catch {
    return oauthError(500, 'misconfigured', 'The agent login could not be completed.');
  }

  // Never return the refresh token: the agent exchanges its PAT again when the access token expires.
  return jsonResponse(200, {
    access_token: session.access_token,
    token_type: 'Bearer',
    expires_in: session.expires_in,
    agent_id: row.agent_id,
    workspace_id: row.workspace_id,
  });
}
