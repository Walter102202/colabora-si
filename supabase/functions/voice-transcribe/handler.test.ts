import assert from 'node:assert/strict';
import { ProviderError } from '../_shared/voice/meta.ts';
import { handleVoiceTranscribe, MAX_BODY_BYTES, type VoiceDeps } from './handler.ts';

const WS = '00000000-0000-4000-8000-000000000001';

function wav(data = 48000): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => out[at + i] = c.charCodeAt(0));
  put(0, 'RIFF'); v.setUint32(4, 36 + data, true); put(8, 'WAVE'); put(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true);
  v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  put(36, 'data'); v.setUint32(40, data, true);
  return out;
}

function deps(over: Partial<VoiceDeps> = {}) {
  const log: string[] = [];
  const d: VoiceDeps = {
    reserve: (_t, a) => { log.push(`reserve:${a.duration_ms}:${a.channel}:${a.forwarded}`); return Promise.resolve({ clip_id: 'clip' }); },
    transcribe: () => { log.push('model'); return Promise.resolve({ transcript: 'hola', audioMs: 1000 }); },
    complete: (id, ms) => { log.push(`complete:${id}:${ms}`); return Promise.resolve(); },
    fail: (id, code) => { log.push(`fail:${id}:${code}`); return Promise.resolve(); },
    ...over,
  };
  return { d, log };
}

function post(body: BodyInit | null = wav(), q = `workspace_id=${WS}`, headers: Record<string, string> = {}) {
  return new Request(`http://x/voice-transcribe?${q}`, { method: 'POST', body, headers: { Authorization: 'Bearer t', 'Content-Type': 'audio/wav', ...headers } });
}

Deno.test('a clip goes reserve, model, complete, and the transcript returns to the caller', async () => {
  const { d, log } = deps();
  const res = await handleVoiceTranscribe(post(), d);
  assert.deepEqual(res.status, 200);
  assert.deepEqual(await res.json(), { clip_id: 'clip', transcript: 'hola', duration_ms: 1000 });
  assert.deepEqual(log, ['reserve:1000:surface:false', 'model', 'complete:clip:1000']);
});

Deno.test('a refusal reaches no model', async () => {
  const { d, log } = deps({ reserve: () => Promise.reject({ code: 'PT402', message: 'budget_exceeded' }) });
  const res = await handleVoiceTranscribe(post(), d);
  assert.deepEqual([res.status, (await res.json()).error], [402, 'budget_exceeded']);
  assert.deepEqual(log, []);
});

Deno.test('a repeated delivery reaches no model', async () => {
  const { d, log } = deps({ reserve: () => Promise.resolve({ duplicate: true }) });
  const res = await handleVoiceTranscribe(post(wav(), 'channel=telegram&chat_id=5&message_id=9'), d);
  assert.deepEqual(await res.json(), { duplicate: true });
  assert.deepEqual(log, []);
});

Deno.test('the duration is measured, whatever the caller says', async () => {
  const { d, log } = deps();
  await handleVoiceTranscribe(post(wav(240000), `workspace_id=${WS}&duration_ms=1`), d);
  assert.deepEqual(log[0], 'reserve:5000:surface:false');
});

Deno.test('a channel marks a forwarded clip', async () => {
  const { d, log } = deps();
  await handleVoiceTranscribe(post(wav(), 'channel=telegram&chat_id=5&forwarded=1'), d);
  assert.deepEqual(log[0], 'reserve:1000:telegram:true');
});

Deno.test('what is not a clip stops before any call', async () => {
  for (const [req, status] of [
    [new Request('http://x/', { method: 'GET' }), 405],
    [new Request('http://x/', { method: 'POST', body: wav(), headers: { 'Content-Type': 'audio/wav' } }), 401],
    [post(wav(), `workspace_id=${WS}`, { 'Content-Type': 'audio/ogg' }), 415],
    [post(wav(), `workspace_id=${WS}`, { 'Content-Length': String(MAX_BODY_BYTES + 1) }), 413],
    [post(wav(), ''), 400],
    [post(wav(), 'workspace_id=nope'), 400],
    [post(wav(), `workspace_id=${WS}&message_id=abc`), 400],
    [post(new TextEncoder().encode('OggS'.padEnd(100, 'x'))), 400],
  ] as const) {
    const { d, log } = deps();
    assert.deepEqual((await handleVoiceTranscribe(req, d)).status, status);
    assert.deepEqual(log, []);
  }
});

// A stream that counts what was read, in chunks of 1 MB.
function counted(chunks: number) {
  const seen = { pulled: 0 };
  const stream = new ReadableStream({ pull(c) { if (seen.pulled++ < chunks) c.enqueue(new Uint8Array(1_000_000)); else c.close(); } });
  return { stream, seen };
}

Deno.test('a body that grows past the limit without saying so is refused, after reading it to its end', async () => {
  const { stream, seen } = counted(40);
  const { d, log } = deps();
  const res = await handleVoiceTranscribe(post(stream), d);
  assert.deepEqual(res.status, 413);
  assert.deepEqual(log, []);
  assert.deepEqual(seen.pulled, 41);
});

Deno.test('every refusal reads the body first: the hosted runtime hangs a client that is answered early', async () => {
  for (const [q, headers, status] of [
    [`workspace_id=${WS}`, { 'Content-Type': 'audio/ogg' }, 415],
    [`workspace_id=${WS}`, { Authorization: '' }, 401],
    [`workspace_id=${WS}`, { 'Content-Length': String(MAX_BODY_BYTES + 1) }, 413],
    ['workspace_id=nope', {}, 400],
  ] as const) {
    const { stream, seen } = counted(3);
    const { d } = deps();
    assert.deepEqual((await handleVoiceTranscribe(post(stream, q, headers), d)).status, status);
    assert.deepEqual(seen.pulled, 4);
  }
});

Deno.test('a provider failure ends the reservation, says nothing about the provider and charges nothing', async () => {
  const { d, log } = deps({ transcribe: () => Promise.reject(new ProviderError(500)) });
  const res = await handleVoiceTranscribe(post(), d);
  assert.deepEqual([res.status, (await res.json()).error], [502, 'voice_failed']);
  assert.deepEqual(log, ['reserve:1000:surface:false', 'fail:clip:provider_500']);
});

Deno.test('a busy provider asks to retry', async () => {
  const { d } = deps({ transcribe: () => Promise.reject(new ProviderError(429)) });
  const res = await handleVoiceTranscribe(post(), d);
  assert.deepEqual([res.status, res.headers.get('Retry-After'), (await res.json()).error], [503, '5', 'voice_busy']);
});

Deno.test('a network failure ends the reservation too', async () => {
  const { d, log } = deps({ transcribe: () => Promise.reject(new TypeError('fetch failed')) });
  assert.deepEqual((await handleVoiceTranscribe(post(), d)).status, 502);
  assert(log.includes('fail:clip:provider_unreachable'));
});

Deno.test('an empty transcript is an answer, and it is paid', async () => {
  const { d, log } = deps({ transcribe: () => Promise.resolve({ transcript: '', audioMs: 1000 }) });
  const res = await handleVoiceTranscribe(post(), d);
  assert.deepEqual((await res.json()).transcript, '');
  assert(log.includes('complete:clip:1000'));
});

Deno.test('a preflight answers without a token', async () => {
  const { d, log } = deps();
  const res = await handleVoiceTranscribe(new Request('http://x/', { method: 'OPTIONS' }), d);
  assert.deepEqual(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.deepEqual(log, []);
});
