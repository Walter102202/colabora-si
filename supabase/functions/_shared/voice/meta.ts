// The transcription provider, behind one function. Nothing else in the repo knows its URL or its fields.
// Contract: POST {base}/v1/asr/transcribe, multipart with a JSON part `request` and a WAV part `audio`. A file request
// answers {sessionId, transcript, audioDurationMs, turns}. Failed requests and 429 are not charged.

export const VOICE_MODEL = 'muse-voice-transcribe-1.0';

export interface Transcription {
  transcript: string;
  audioMs: number | null;
}

export class ProviderError extends Error {
  constructor(public readonly status: number) {
    super(`provider answered ${status}`);
    this.name = 'ProviderError';
  }
}

// Written by hand: FormData adds a filename to the request part, and the documented request has none.
function multipart(request: string, wav: Uint8Array<ArrayBuffer>): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `colabora${crypto.randomUUID().replaceAll('-', '')}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${request}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + wav.length + tail.length);
  body.set(head);
  body.set(wav, head.length);
  body.set(tail, head.length + wav.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface ProviderOptions {
  apiKey: string;
  baseUrl?: string;
  languageBias?: string[];
  keywords?: string[];
  fetchImpl?: typeof fetch;
}

export async function transcribeWav(wav: Uint8Array<ArrayBuffer>, signal: AbortSignal, opts: ProviderOptions): Promise<Transcription> {
  const request: Record<string, unknown> = { model: VOICE_MODEL, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' };
  if (opts.languageBias?.length) request.languageBias = opts.languageBias;
  if (opts.keywords?.length) request.keywords = opts.keywords;
  const { body: payload, contentType } = multipart(JSON.stringify(request), wav);
  const res = await (opts.fetchImpl ?? fetch)(`${(opts.baseUrl ?? 'https://api.meta.ai').replace(/\/+$/, '')}/v1/asr/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: 'application/json', 'Content-Type': contentType },
    body: payload,
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ProviderError(res.status);
  }
  const body = await res.json().catch(() => null) as { transcript?: unknown; audioDurationMs?: unknown } | null;
  if (typeof body?.transcript !== 'string') throw new ProviderError(502);
  const audioMs = Number(body.audioDurationMs);
  return { transcript: body.transcript.trim(), audioMs: Number.isFinite(audioMs) && audioMs > 0 ? audioMs : null };
}

/** A comma-separated secret as a list; empty means the field is not sent. */
export function listSetting(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
