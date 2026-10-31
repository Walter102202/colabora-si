import assert from 'node:assert/strict';
import { listSetting, ProviderError, transcribeWav } from './meta.ts';

const never = new AbortController().signal;
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const sent = (init: RequestInit) => new Request('http://x/', { method: 'POST', headers: init.headers, body: init.body });

Deno.test('the request is the documented multipart', async () => {
  let url = '', init: RequestInit = {};
  await transcribeWav(new Uint8Array([1, 2, 3]), never, {
    apiKey: 'k', baseUrl: 'http://stub/', languageBias: ['Spanish'], keywords: ['colabora'],
    fetchImpl: ((u: string, i: RequestInit) => { url = u; init = i; return Promise.resolve(ok({ transcript: 'hola', audioDurationMs: 1000, turns: [] })); }) as typeof fetch,
  });
  assert.deepEqual(url, 'http://stub/v1/asr/transcribe');
  assert.deepEqual((init.headers as Record<string, string>).Authorization, 'Bearer k');
  assert.deepEqual((init.headers as Record<string, string>).Accept, 'application/json');
  const raw = new TextDecoder('latin1').decode(init.body as Uint8Array);
  assert.ok(raw.includes('name="request"\r\nContent-Type: application/json\r\n\r\n'), 'the request part has no filename');
  const form = await sent(init).formData();
  assert.deepEqual(JSON.parse(form.get('request') as string), {
    model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', languageBias: ['Spanish'], keywords: ['colabora'],
  });
  const audio = form.get('audio') as File;
  assert.deepEqual([audio.type, audio.name, [...await audio.bytes()]], ['audio/wav', 'recording.wav', [1, 2, 3]]);
});

Deno.test('optional fields stay out, so the model detects the language', async () => {
  let init: RequestInit = {};
  await transcribeWav(new Uint8Array(1), never, { apiKey: 'k', fetchImpl: ((_: string, i: RequestInit) => { init = i; return Promise.resolve(ok({ transcript: 'x' })); }) as typeof fetch });
  assert.deepEqual(Object.keys(JSON.parse((await sent(init).formData()).get('request') as string)), ['model', 'audioEncoding', 'mode']);
});

Deno.test('the answer is trimmed and the duration may come as a string', async () => {
  const out = await transcribeWav(new Uint8Array(1), never, { apiKey: 'k', fetchImpl: (() => Promise.resolve(ok({ transcript: ' hola ', audioDurationMs: '61900' }))) as typeof fetch });
  assert.deepEqual(out, { transcript: 'hola', audioMs: 61900 });
});

Deno.test('no duration leaves it to the caller', async () => {
  const out = await transcribeWav(new Uint8Array(1), never, { apiKey: 'k', fetchImpl: (() => Promise.resolve(ok({ transcript: '' }))) as typeof fetch });
  assert.deepEqual(out, { transcript: '', audioMs: null });
});

for (const status of [400, 413, 429, 500]) {
  Deno.test(`${status} becomes a ProviderError with no body in it`, async () => {
    const err = await transcribeWav(new Uint8Array(1), never, { apiKey: 'k', fetchImpl: (() => Promise.resolve(ok({ error: { message: 'secret detail' } }, status))) as typeof fetch }).catch((e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.status, status);
    assert.ok(!err.message.includes('secret'));
  });
}

Deno.test('a body without a transcript is a failure, not an empty note', async () => {
  await assert.rejects(() => transcribeWav(new Uint8Array(1), never, { apiKey: 'k', fetchImpl: (() => Promise.resolve(ok({ turns: [] }))) as typeof fetch }), ProviderError);
});

Deno.test('listSetting', () => {
  assert.deepEqual(listSetting(' Spanish, English ,'), ['Spanish', 'English']);
  assert.deepEqual(listSetting(undefined), []);
});
