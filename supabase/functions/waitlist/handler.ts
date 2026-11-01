// Pure handler of waitlist: one email from the landing. The answer is the same for a new and a repeated address, so it
// reveals nobody; that includes its timing, so the Notion copy and the confirmation run after it. Both are best effort:
// the saved row is the record, a failed copy stays unsynced and a failed confirmation stays owed.
import { jsonResponse, oauthError } from '../_shared/errors.ts';

export const MAX_BODY_BYTES = 2_048;
/** How many older rows one signup may also catch up, per step. */
export const CATCH_UP_BATCH = 5;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface JoinResult {
  outcome: 'added' | 'exists' | 'rate_limited';
  id?: string;
}

export interface Unconfirmed {
  id: string;
  email: string;
}

export interface Unsynced extends Unconfirmed {
  created_at: string;
}

export interface WaitlistDeps {
  appOrigin: string;
  hashIp(ip: string): Promise<string>;
  join(email: string, ipHash: string): Promise<JoinResult>;
  markSynced(id: string): Promise<void>;
  /** Keeps the work alive after the answer. */
  background(work: Promise<unknown>): void;
  /** Absent without the Notion secrets. */
  copyToNotion?(email: string, at: Date): Promise<void>;
  unsynced(limit: number): Promise<Unsynced[]>;
  /** Absent without the Resend key. */
  sendConfirmation?(email: string, id: string): Promise<void>;
  unconfirmed(limit: number): Promise<Unconfirmed[]>;
  markConfirmed(id: string): Promise<void>;
}

function corsHeaders(appOrigin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': appOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

// The hosted runtime hangs the client when a function answers before reading the whole body (edge-runtime#737), so an
// oversized request is read to its end too. Nothing past the limit is kept.
async function readBody(req: Request): Promise<string | null> {
  if (!req.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) return null;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(out);
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || forwarded || 'unknown';
}

function parse(text: string): { email: string; company: string } | null {
  try {
    const body = JSON.parse(text) as { email?: unknown; company?: unknown } | null;
    return { email: typeof body?.email === 'string' ? body.email : '', company: typeof body?.company === 'string' ? body.company : '' };
  } catch {
    return null;
  }
}

const reason = (err: unknown) => err instanceof Error ? err.message : 'unknown';

async function owed<T extends Unconfirmed>(lookup: Promise<T[]>, row: Unconfirmed): Promise<T[]> {
  const rows = await lookup.catch((err) => {
    console.error('waitlist lookup failed:', reason(err));
    return [] as T[];
  });
  return rows.filter((other) => other.id !== row.id);
}

// In both steps the new address goes first, then the rows still owed. One refusal stops nothing: the next may well pass.
async function copy(row: Unconfirmed, deps: WaitlistDeps): Promise<void> {
  const send = deps.copyToNotion;
  if (!send) return;
  const late = await owed(deps.unsynced(CATCH_UP_BATCH), row);
  for (const { id, email, at } of [{ ...row, at: new Date() }, ...late.map((other) => ({ ...other, at: new Date(other.created_at) }))]) {
    try {
      await send(email, at);
      await deps.markSynced(id);
    } catch (err) {
      console.error('waitlist notion copy failed:', reason(err));
    }
  }
}

async function confirm(row: Unconfirmed, deps: WaitlistDeps): Promise<void> {
  const send = deps.sendConfirmation;
  if (!send) return;
  const late = await owed(deps.unconfirmed(CATCH_UP_BATCH), row);
  for (const { id, email } of [row, ...late]) {
    try {
      await send(email, id);
      await deps.markConfirmed(id);
    } catch (err) {
      console.error('waitlist confirmation failed:', reason(err));
    }
  }
}

async function afterJoin(row: Unconfirmed, deps: WaitlistDeps): Promise<void> {
  await copy(row, deps);
  await confirm(row, deps);
}

export async function handleWaitlist(req: Request, deps: WaitlistDeps): Promise<Response> {
  const fromApp = req.headers.get('Origin') === deps.appOrigin;
  const cors = fromApp ? corsHeaders(deps.appOrigin) : {};
  if (req.method === 'OPTIONS') return new Response(null, { status: fromApp ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return oauthError(405, 'method_not_allowed', 'Use POST.', { ...cors, Allow: 'POST, OPTIONS' });

  const text = await readBody(req);
  if (!fromApp) return oauthError(403, 'forbidden_origin', 'This origin may not join the waitlist.');
  if (text === null) return oauthError(413, 'body_too_large', 'The request is too large.', cors);
  const body = parse(text);
  if (!body) return oauthError(400, 'invalid_request', 'The body must be JSON.', cors);
  if (body.company) return jsonResponse(200, { ok: true }, cors);

  const email = body.email.trim().toLowerCase();
  if (email.length > MAX_EMAIL || !EMAIL.test(email)) return oauthError(400, 'invalid_email', 'Check the email address.', cors);

  const joined = await deps.join(email, await deps.hashIp(clientIp(req)));
  if (joined.outcome === 'rate_limited') return oauthError(429, 'rate_limited', 'Too many attempts. Try again later.', cors);
  if (joined.outcome === 'added' && joined.id) deps.background(afterJoin({ id: joined.id, email }, deps));
  return jsonResponse(200, { ok: true }, cors);
}
