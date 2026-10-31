// Press to talk in the browser. The transcription model takes WAV only and no browser records it, so the microphone goes
// through an AudioWorklet and this file writes the file. The audio stays in memory: a retry reuses it and nothing is stored.

export const TARGET_RATE = 24000;
export const MAX_RECORDING_MS = 300_000;
export const VOICE_NOTICE = "Audio is sent to Meta to transcribe and is not kept.";

export type VoiceFailure = "mic_denied" | "no_mic" | "unsupported" | "voice_too_short" | "voice_too_long" | "voice_too_large" | "voice_quota" | "budget_exceeded" | "voice_busy" | "no_platform_agent" | "no_speech" | "network" | "voice_failed";

export type VoiceState =
  | { phase: "idle" }
  | { phase: "asking" }
  | { phase: "recording"; startedAt: number }
  | { phase: "sending" }
  | { phase: "transcribing" }
  | { phase: "review"; clipId: string; transcript: string }
  | { phase: "failed"; reason: VoiceFailure; canRetry: boolean };

export type VoiceEvent =
  | { type: "press" }
  | { type: "granted"; at: number }
  | { type: "stop" }
  | { type: "sent" }
  | { type: "heard"; clipId: string; transcript: string }
  | { type: "fail"; reason: VoiceFailure; canRetry: boolean }
  | { type: "retry" }
  | { type: "reset" };

// One table for what can happen in each state. An event a state does not name changes nothing, so a late callback
// from a cancelled recording cannot bring a closed state back.
export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  if (event.type === "reset") return { phase: "idle" };
  switch (state.phase) {
    case "review":
    case "idle": return event.type === "press" ? { phase: "asking" } : state;
    case "asking":
      if (event.type === "granted") return { phase: "recording", startedAt: event.at };
      return event.type === "fail" ? { phase: "failed", reason: event.reason, canRetry: event.canRetry } : state;
    case "recording":
      if (event.type === "stop") return { phase: "sending" };
      return event.type === "fail" ? { phase: "failed", reason: event.reason, canRetry: event.canRetry } : state;
    case "sending":
      if (event.type === "sent") return { phase: "transcribing" };
      if (event.type === "heard") return { phase: "review", clipId: event.clipId, transcript: event.transcript };
      return event.type === "fail" ? { phase: "failed", reason: event.reason, canRetry: event.canRetry } : state;
    case "transcribing":
      if (event.type === "heard") return { phase: "review", clipId: event.clipId, transcript: event.transcript };
      return event.type === "fail" ? { phase: "failed", reason: event.reason, canRetry: event.canRetry } : state;
    case "failed":
      if (event.type === "retry" && state.canRetry) return { phase: "sending" };
      return event.type === "press" ? { phase: "asking" } : state;
    default: return state;
  }
}

const FAILURE_TEXT: Record<VoiceFailure, string> = {
  mic_denied: "The browser blocked the microphone. Allow it in the site settings, or type your message.",
  no_mic: "No microphone found. Type your message instead.",
  unsupported: "This browser cannot record audio. Type your message instead.",
  voice_too_short: "That was too short. Hold on a little longer.",
  voice_too_long: "That is over 5 minutes. Record a shorter one.",
  voice_too_large: "That recording is too large. Record a shorter one.",
  voice_quota: "You reached the voice limit for now. Try later or type your message.",
  budget_exceeded: "The agent reached its budget for this month.",
  voice_busy: "Too many recordings right now. Try again in a moment.",
  no_platform_agent: "There is no active agent in this workspace yet.",
  no_speech: "No words were heard. Try again.",
  network: "The recording did not reach the server. Try again.",
  voice_failed: "The transcription failed. Try again.",
};
export const voiceFailureText = (reason: VoiceFailure) => FAILURE_TEXT[reason];

const RETRYABLE = new Set<VoiceFailure>(["voice_busy", "network", "voice_failed"]);
export function voiceFailure(code: string): { reason: VoiceFailure; canRetry: boolean } {
  const reason = (code in FAILURE_TEXT ? code : "voice_failed") as VoiceFailure;
  return { reason, canRetry: RETRYABLE.has(reason) };
}

export function joinChunks(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** RIFF, mono, 16-bit PCM. Samples outside -1..1 are clipped. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const tag = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

type Offline = new (channels: number, length: number, rate: number) => OfflineAudioContext;

/** Resamples at the end, in the browser's own engine. The recording context keeps the device rate: Firefox refuses another. */
export async function resample(samples: Float32Array, from: number, to = TARGET_RATE, Context?: Offline): Promise<Float32Array> {
  if (from === to) return samples;
  const length = Math.ceil((samples.length * to) / from);
  const context = new (Context ?? OfflineAudioContext)(1, length, to);
  const source = context.createBufferSource();
  const buffer = context.createBuffer(1, samples.length, from);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return (await context.startRendering()).getChannelData(0);
}

const WORKLET = `class ColaboraCapture extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
}
registerProcessor("colabora-capture", ColaboraCapture);`;

export interface Recorder {
  stop(): Promise<ArrayBuffer>;
  cancel(): void;
}

/** Asks for the microphone only here, on the first press. Throws a VoiceFailure code as the error message. */
export async function startRecorder(): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw new Error("unsupported");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    throw new Error((error as DOMException)?.name === "NotFoundError" ? "no_mic" : "mic_denied");
  }
  const context = new AudioContext();
  // Created after an await, so outside the gesture: without this a browser can leave it suspended and record silence.
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  const chunks: Float32Array[] = [];
  const close = () => {
    stream.getTracks().forEach((t) => t.stop());
    void context.close().catch(() => {});
  };
  try {
    await context.resume();
    await context.audioWorklet.addModule(url);
  } catch {
    close();
    throw new Error("unsupported");
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(context, "colabora-capture", { numberOfOutputs: 0 });
  node.port.onmessage = (e: MessageEvent<Float32Array>) => { chunks.push(e.data); };
  context.createMediaStreamSource(stream).connect(node);
  return {
    async stop() {
      const rate = context.sampleRate;
      close();
      return encodeWav(await resample(joinChunks(chunks), rate), TARGET_RATE);
    },
    cancel: close,
  };
}

export interface VoiceResult {
  clip_id: string;
  transcript: string;
  duration_ms: number;
}

export interface UploadOptions {
  url: string;
  token: string;
  apikey: string;
  wav: ArrayBuffer;
  onSent: () => void;
  makeRequest?: () => XMLHttpRequest;
}

/** XMLHttpRequest and not fetch: only it says when the body left, which is the line between "sending" and "transcribing". */
export function uploadWav({ url, token, apikey, wav, onSent, makeRequest = () => new XMLHttpRequest() }: UploadOptions): Promise<VoiceResult> {
  return new Promise((resolve, reject) => {
    const xhr = makeRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", apikey);
    xhr.setRequestHeader("Content-Type", "audio/wav");
    xhr.upload.onload = onSent;
    xhr.onerror = () => reject(new Error("network"));
    xhr.ontimeout = () => reject(new Error("network"));
    xhr.onload = () => {
      let body: { error?: string } & Partial<VoiceResult> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* the code below decides */ }
      if (xhr.status >= 200 && xhr.status < 300 && typeof body.transcript === "string" && body.clip_id) resolve(body as VoiceResult);
      else reject(new Error(body.error ?? "voice_failed"));
    };
    xhr.send(wav);
  });
}
