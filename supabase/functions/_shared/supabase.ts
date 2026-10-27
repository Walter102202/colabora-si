// Supabase clients for the Edge Functions. None of them persists or refreshes a session.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Env = Record<string, string | undefined>;

export class MisconfiguredError extends Error {
  constructor(missing: string) {
    super(`missing environment variable: ${missing}`);
    this.name = 'MisconfiguredError';
  }
}

const AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

export function denoEnv(): Env {
  return Deno.env.toObject();
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new MisconfiguredError(name);
  return value;
}

/** First key of a JSON map such as SUPABASE_SECRET_KEYS = {"default": "sb_secret_..."}. */
function firstKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed.default ?? Object.values(parsed)[0];
  } catch {
    return undefined;
  }
}

function serviceKey(env: Env): string {
  return env.SUPABASE_SERVICE_ROLE_KEY || firstKey(env.SUPABASE_SECRET_KEYS) ||
    required(env, 'SUPABASE_SERVICE_ROLE_KEY');
}

function anonKey(env: Env): string {
  return env.SUPABASE_ANON_KEY || firstKey(env.SUPABASE_PUBLISHABLE_KEYS) || required(env, 'SUPABASE_ANON_KEY');
}

/** Bypasses RLS. Only agent-token, agent-admin and the dispatch functions may use it. */
export function serviceClient(env: Env): SupabaseClient {
  return createClient(required(env, 'SUPABASE_URL'), serviceKey(env), { auth: AUTH });
}

export function anonClient(env: Env): SupabaseClient {
  return createClient(required(env, 'SUPABASE_URL'), anonKey(env), { auth: AUTH });
}

/** Acts as the caller: PostgREST applies RLS with the caller's JWT. */
export function callerClient(env: Env, token: string): SupabaseClient {
  return createClient(required(env, 'SUPABASE_URL'), anonKey(env), {
    auth: AUTH,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
