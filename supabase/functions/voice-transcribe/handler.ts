// Pure handler of voice-transcribe: one WAV in, one transcript out. The audio stays in memory for this request only.
// voice_reserve decides who may spend and how much. It runs as the caller, so every RLS and session rule applies. The
// provider key and the service role are used only after that answer. A transcript is data: this function acts on nothing.
import { jsonResponse, oauthError } from '../_shared/errors.ts';
import { MisconfiguredError } from '../_shared/supabase.ts';
import { ProviderError, type Transcription } from '../_shared/voice/meta.ts';
import { parseWav, WavError } from '../_shared/voice/wav.ts';

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Mirrors channel_max_bytes in private.voice_limits() (0042). This one only avoids keeping a body the server would refuse.
export const MAX_BODY_BYTES = 29_000_000;
export const MAX_TRANSCRIPT_CHARS = 20_000;
const PROVIDER_TIMEOUT_MS = 120_000;

export interface ReserveArgs {
  workspace_id: string | null;
  duration_ms: number;
  bytes: number;
  channel: string;
  chat_id: string | null;
  forwarded: boolean;
  lang: string;
  message_id: number | null;
}

export interface VoiceDeps {
  reserve(token: string, args: ReserveArgs): Promise<{ clip_id?: string; duplicate?: boolean }>;
  complete(clipId: string, audioMs: number | null): Promise<void>;
  fail(clipId: string, code: string): Promise<void>;
  transcribe(wav: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<Transcription>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, code: string, description: string, extra: HeadersInit = {}) =>
  oauthError(status, code, description, { ...CORS_HEADERS, ...extra });

async function readLimited(req: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  let chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES) chunks = [];
      else chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (size > MAX_BODY_BYTES) return null;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// The hosted runtime hangs the client when a function answers before reading the whole body (edge-runtime#737), so a
// refused request is read to its end too. Nothing of it is kept.
async function drain(req: Request): Promise<void> {
  if (!req.body || req.bodyUsed) return;
  const reader = req.body.getReader();
  try {
    while (!(await reader.read()).done) { /* dropped */ }
  } catch {
    // The client left.
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function dbFailure(err: unknown): Response {
  const e = (err ?? {}) as { code?: string; message?: string; details?: string | null };
  const status = /^PT(\d{3})$/.exec(e.code ?? '')?.[1];
  if (status) return fail(Number(status), e.message || 'invalid_request', 'The clip was refused.');
  return fail(503, 'voice_failed', 'The clip could not be checked.');
}

export async function handleVoiceTranscribe(req: Request, deps: VoiceDeps): Promise<Response> {
  const res = await handle(req, deps);
  await drain(req);
  return res;
}

async function handle(req: Request, deps: VoiceDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.');
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (!token) return fail(401, 'unauthorized', 'Sign in first.');
  if (!(req.headers.get('Content-Type') ?? '').toLowerCase().startsWith('audio/wav')) return fail(415, 'not_wav', 'Send audio/wav.');
  if (Number(req.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) return fail(413, 'voice_too_large', 'The clip is too large.');

  const q = new URL(req.url).searchParams;
  const channel = q.get('channel') ?? 'surface';
  const workspace = q.get('workspace_id');
  const message = q.get('message_id');
  if ((workspace && !UUID.test(workspace)) || (channel === 'surface' && !workspace) || (message && !/^[0-9]{1,18}$/.test(message))) {
    return fail(400, 'invalid_request', 'Bad clip parameters.');
  }

  const bytes = await readLimited(req);
  if (!bytes) return fail(413, 'voice_too_large', 'The clip is too large.');
  let durationMs: number;
  try {
    durationMs = parseWav(bytes).durationMs;
  } catch (err) {
    if (err instanceof WavError) return fail(400, err.reason, 'The audio is not mono 16-bit WAV at 16 or 24 kHz.');
    throw err;
  }

  let clipId: string | undefined;
  try {
    const reserved = await deps.reserve(token, {
      workspace_id: workspace, duration_ms: durationMs, bytes: bytes.length, channel, chat_id: q.get('chat_id'),
      forwarded: q.get('forwarded') === '1', lang: q.get('lang') === 'en' ? 'en' : 'es', message_id: message ? Number(message) : null,
    });
    if (reserved.duplicate) return jsonResponse(200, { duplicate: true }, CORS_HEADERS);
    clipId = reserved.clip_id;
  } catch (err) {
    if (err instanceof MisconfiguredError) throw err;
    return dbFailure(err);
  }
  if (!clipId) return fail(503, 'voice_failed', 'The clip could not be checked.');

  let result: Transcription;
  try {
    result = await deps.transcribe(bytes, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : 0;
    await deps.fail(clipId, status ? `provider_${status}` : 'provider_unreachable').catch(() => {});
    if (status === 429) return fail(503, 'voice_busy', 'Too many clips right now. Try again shortly.', { 'Retry-After': '5' });
    if (err instanceof MisconfiguredError) throw err;
    return fail(502, 'voice_failed', 'The transcription failed.');
  }
  try {
    await deps.complete(clipId, result.audioMs);
  } catch {
    return fail(503, 'voice_failed', 'The transcription could not be recorded.');
  }
  return jsonResponse(200, { clip_id: clipId, transcript: result.transcript.slice(0, MAX_TRANSCRIPT_CHARS), duration_ms: durationMs }, CORS_HEADERS);
}
