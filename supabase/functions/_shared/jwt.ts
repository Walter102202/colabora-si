// Bearer validation for the mcp function (verify_jwt = false, so the function checks the token itself).
// The signature is verified by supabase-js getClaims against the project JWKS; the claims are then checked here.
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, type Env } from './supabase.ts';

export type PrincipalType = 'human' | 'agent';

export interface Principal {
  type: PrincipalType;
  userId: string;
  /** Agent id from app_metadata; null for people. */
  agentId: string | null;
  workspaceId: string | null;
  /** OAuth client of a person's connection (chat apps); null for direct sessions and agents. */
  clientId: string | null;
}

export interface VerifiedBearer {
  token: string;
  claims: Record<string, unknown>;
  principal: Principal;
}

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, readonly code: 'invalid_token' | 'wrong_principal', message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Verifies the signature and expiry of a JWT; resolves with its claims or an error (supabase-js getClaims shape). */
export type ClaimsVerifier = (
  token: string,
) => Promise<{ data: { claims: Record<string, unknown> } | null; error: unknown }>;

const verifierCache = new Map<string, SupabaseClient>();

/** getClaims of a cached anon client: the JWKS is fetched once per isolate and reused. */
export function supabaseClaimsVerifier(env: Env): ClaimsVerifier {
  const key = env.SUPABASE_URL ?? '';
  let client = verifierCache.get(key);
  if (!client) {
    client = anonClient(env);
    verifierCache.set(key, client);
  }
  const auth = client.auth;
  return async (token) => {
    const { data, error } = await auth.getClaims(token);
    return { data: data ? { claims: data.claims as unknown as Record<string, unknown> } : null, error };
  };
}

function decodePayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function expectedIssuer(env: Env): string {
  if (env.MCP_AUTH_SERVER_URL) return env.MCP_AUTH_SERVER_URL.replace(/\/+$/, '');
  return `${(env.SUPABASE_URL ?? '').replace(/\/+$/, '')}/auth/v1`;
}

function audienceOk(aud: unknown): boolean {
  if (typeof aud === 'string') return aud === 'authenticated';
  return Array.isArray(aud) && aud.includes('authenticated');
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Validates `Authorization: Bearer <jwt>` (§IV.8.5). Throws AuthError:
 * 401 invalid_token when the header is missing or the token does not verify;
 * 403 wrong_principal for anon/service_role tokens and API keys.
 */
export async function verifyBearer(req: Request, env: Env, verify?: ClaimsVerifier): Promise<VerifiedBearer> {
  const header = req.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) throw new AuthError(401, 'invalid_token', 'Missing bearer token.');
  const token = match[1];

  if (/^sb_(secret|publishable)_/.test(token)) {
    throw new AuthError(403, 'wrong_principal', 'API keys are not accepted; use a user or agent access token.');
  }
  const unverified = decodePayload(token);
  if (!unverified) throw new AuthError(401, 'invalid_token', 'The bearer is not a JWT.');
  // Rejecting before verification never grants anything: anon and service_role are refused either way.
  if (unverified.role === 'anon' || unverified.role === 'service_role') {
    throw new AuthError(403, 'wrong_principal', `Tokens with role ${unverified.role} are not accepted.`);
  }

  let claims: Record<string, unknown> | null = null;
  try {
    const { data, error } = await (verify ?? supabaseClaimsVerifier(env))(token);
    if (!error && data) claims = data.claims;
  } catch {
    claims = null;
  }
  if (!claims) throw new AuthError(401, 'invalid_token', 'The token signature or expiry is invalid.');

  if (str(claims.iss)?.replace(/\/+$/, '') !== expectedIssuer(env)) {
    throw new AuthError(401, 'invalid_token', 'The token was issued by another server.');
  }
  if (!audienceOk(claims.aud)) throw new AuthError(401, 'invalid_token', 'The token audience is not "authenticated".');
  if (claims.role === 'anon' || claims.role === 'service_role') {
    throw new AuthError(403, 'wrong_principal', `Tokens with role ${claims.role} are not accepted.`);
  }
  if (claims.role !== 'authenticated') throw new AuthError(401, 'invalid_token', 'The token role is not "authenticated".');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new AuthError(401, 'invalid_token', 'The token has expired.');
  }
  const sub = str(claims.sub);
  if (!sub) throw new AuthError(401, 'invalid_token', 'The token has no subject.');

  const meta = (typeof claims.app_metadata === 'object' && claims.app_metadata !== null
    ? claims.app_metadata
    : {}) as Record<string, unknown>;
  const rawType = meta.principal_type ?? 'human';
  if (rawType !== 'human' && rawType !== 'agent') {
    throw new AuthError(403, 'wrong_principal', `Principal type ${String(rawType)} is not accepted.`);
  }
  const agentId = str(meta.agent_id);
  if (rawType === 'agent' && !agentId) {
    throw new AuthError(401, 'invalid_token', 'Agent token without agent_id.');
  }

  return {
    token,
    claims,
    principal: {
      type: rawType,
      userId: sub,
      agentId: rawType === 'agent' ? agentId : null,
      workspaceId: str(meta.workspace_id),
      clientId: str(claims.client_id),
    },
  };
}
