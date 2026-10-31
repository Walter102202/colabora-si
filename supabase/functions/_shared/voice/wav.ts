// Reads what a WAV file says about itself. The transcription model takes RIFF, mono, 16-bit PCM at 16 or 24 kHz.
// The duration is measured over the bytes that arrived, so a header that lies cannot make a clip look shorter.

export interface WavInfo {
  sampleRate: number;
  durationMs: number;
  dataBytes: number;
}

export class WavError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'WavError';
  }
}

const tag = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

export function parseWav(bytes: Uint8Array): WavInfo {
  if (bytes.length < 44 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') throw new WavError('not_wav');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sampleRate = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(bytes, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      if (body + 16 > bytes.length) throw new WavError('bad_format');
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const bits = view.getUint16(body + 14, true);
      sampleRate = view.getUint32(body + 4, true);
      if (format !== 1 || channels !== 1 || bits !== 16 || (sampleRate !== 16000 && sampleRate !== 24000)) throw new WavError('bad_format');
    } else if (id === 'data') {
      if (!sampleRate) throw new WavError('bad_format');
      const dataBytes = bytes.length - body;
      if (dataBytes <= 0) throw new WavError('no_audio');
      return { sampleRate, dataBytes, durationMs: Math.ceil((dataBytes / (sampleRate * 2)) * 1000) };
    }
    at = body + size + (size % 2);
  }
  throw new WavError('no_audio');
}
