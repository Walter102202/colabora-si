// Pure handler of waitlist: one email from the landing. The answer is the same for a new and a repeated address, so it
// reveals nobody. The Notion copy is best effort: the saved row is the record, and a failed copy stays marked unsynced.
import { jsonResponse, oauthError } from '../_shared/errors.ts';

export const MAX_BODY_BYTES = 2_048;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface JoinResult {
  outcome: 'added' | 'exists' | 'rate_limited';
  id?: string;
}

export interface WaitlistDeps {
  appOrigin: string;
  hashIp(ip: string): Promise<string>;
  join(email: string, ipHash: string): Promise<JoinResult>;
  markSynced(id: string): Promise<void>;
  /** Absent without the Notion secrets. */
  copyToNotion?(email: string, at: Date): Promise<void>;
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
  if (joined.outcome === 'added' && joined.id && deps.copyToNotion) {
    try {
      await deps.copyToNotion(email, new Date());
      await deps.markSynced(joined.id);
    } catch (err) {
      console.error('waitlist notion copy failed:', err instanceof Error ? err.message : 'unknown');
    }
  }
  return jsonResponse(200, { ok: true }, cors);
}
