import assert from 'node:assert/strict';
import { parseWav, WavError } from './wav.ts';

function wav({ rate = 24000, channels = 1, bits = 16, format = 1, data = 48000, declared = undefined as number | undefined } = {}): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => out[at + i] = c.charCodeAt(0));
  put(0, 'RIFF'); v.setUint32(4, 36 + data, true); put(8, 'WAVE'); put(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, format, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bits / 8, true); v.setUint16(32, channels * bits / 8, true); v.setUint16(34, bits, true);
  put(36, 'data'); v.setUint32(40, declared ?? data, true);
  return out;
}

Deno.test('a second of 24 kHz mono is a second', () => {
  assert.deepEqual(parseWav(wav()), { sampleRate: 24000, dataBytes: 48000, durationMs: 1000 });
});

Deno.test('16 kHz is accepted too', () => {
  assert.deepEqual(parseWav(wav({ rate: 16000, data: 32000 })).durationMs, 1000);
});

Deno.test('a header cannot make a clip look shorter than its bytes', () => {
  assert.deepEqual(parseWav(wav({ data: 480000, declared: 480 })).durationMs, 10000);
});

Deno.test('a chunk before the data is skipped', () => {
  const base = wav({ data: 4800 });
  const out = new Uint8Array(base.length + 12);
  out.set(base.subarray(0, 36));
  out.set([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0], 36);
  out.set(base.subarray(36), 48);
  assert.deepEqual(parseWav(out).durationMs, 100);
});

for (const [name, bytes] of [
  ['stereo', wav({ channels: 2 })], ['8 bits', wav({ bits: 8 })], ['float', wav({ format: 3 })], ['44.1 kHz', wav({ rate: 44100 })],
  ['an Ogg file', new TextEncoder().encode('OggS'.padEnd(200, 'x'))], ['nothing', new Uint8Array(0)],
] as const) {
  Deno.test(`${name} is refused`, () => {
    assert.throws(() => parseWav(bytes as Uint8Array), WavError);
  });
}

Deno.test('a header with no audio is refused', () => {
  assert.throws(() => parseWav(wav({ data: 0 })), { reason: 'no_audio' });
  assert.throws(() => parseWav(wav({ data: 200 }).subarray(0, 44)), { reason: 'no_audio' });
});
