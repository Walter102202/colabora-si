import { describe, expect, it, vi } from "vitest";
import { mergeMessages, type PersonMessage } from "@/lib/agentConversation";
import { encodeWav, joinChunks, resample, startRecorder, TARGET_RATE, uploadWav, voiceFailure, voiceFailureText, voiceReducer, type VoiceEvent, type VoiceState } from "@/lib/agentVoice";

const run = (events: VoiceEvent[], from: VoiceState = { phase: "idle" }) => events.reduce(voiceReducer, from);

describe("resuming the microphone context", () => {
  it.each([false, true])("resume rejects=%s: capture starts only after resume and releases resources", async (rejects) => {
    const stop = vi.fn();
    const close = vi.fn(async () => {});
    const resume = vi.fn(async () => { if (rejects) throw new Error("blocked"); });
    const connect = vi.fn();
    class Context {
      resume = resume;
      close = close;
      sampleRate = TARGET_RATE;
      audioWorklet = { addModule: vi.fn(async () => {}) };
      createMediaStreamSource() { return { connect }; }
    }
    class Worklet { port = { onmessage: null }; }
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("AudioWorkletNode", Worklet);
    try {
      if (rejects) {
        await expect(startRecorder()).rejects.toThrow("unsupported");
        expect(connect).not.toHaveBeenCalled();
      } else {
        const recorder = await startRecorder();
        expect(connect).toHaveBeenCalledOnce();
        recorder.cancel();
      }
      expect(resume).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("the states of a recording", () => {
  it("goes from a press to a transcript to review", () => {
    expect(run([{ type: "press" }, { type: "granted", at: 1 }, { type: "stop" }, { type: "sent" }, { type: "heard", clipId: "c", transcript: "hola" }]))
      .toEqual({ phase: "review", clipId: "c", transcript: "hola" });
  });
  it("a fast answer can arrive before the sent event", () => {
    expect(run([{ type: "press" }, { type: "granted", at: 1 }, { type: "stop" }, { type: "heard", clipId: "c", transcript: "x" }]).phase).toBe("review");
  });
  it("a denied microphone ends in a failure with no retry", () => {
    expect(run([{ type: "press" }, { type: "fail", ...voiceFailure("mic_denied") }])).toEqual({ phase: "failed", reason: "mic_denied", canRetry: false });
  });
  it("retries only what can be retried", () => {
    expect(run([{ type: "retry" }], { phase: "failed", reason: "voice_busy", canRetry: true }).phase).toBe("sending");
    expect(run([{ type: "retry" }], { phase: "failed", reason: "voice_quota", canRetry: false }).phase).toBe("failed");
  });
  it("a new press works after a failure", () => {
    expect(run([{ type: "press" }], { phase: "failed", reason: "no_speech", canRetry: false }).phase).toBe("asking");
  });
  it("a late answer from a cancelled recording changes nothing", () => {
    expect(run([{ type: "press" }, { type: "granted", at: 1 }, { type: "reset" }, { type: "heard", clipId: "c", transcript: "x" }, { type: "sent" }])).toEqual({ phase: "idle" });
  });
  it("a second press while recording does nothing", () => {
    const state: VoiceState = { phase: "recording", startedAt: 1 };
    expect(voiceReducer(state, { type: "press" })).toBe(state);
  });
});

describe("failures", () => {
  it("an unknown code is a plain failure that can be retried", () => {
    expect(voiceFailure("whatever")).toEqual({ reason: "voice_failed", canRetry: true });
  });
  it.each(["voice_quota", "budget_exceeded", "voice_too_long", "mic_denied"])("%s is not retried by hand", (code) => {
    expect(voiceFailure(code).canRetry).toBe(false);
    expect(voiceFailureText(voiceFailure(code).reason)).not.toBe("");
  });
});

describe("the WAV", () => {
  it("has the header the model reads", () => {
    const view = new DataView(encodeWav(new Float32Array(24000), TARGET_RATE));
    const text = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(28, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(48000);
    expect(view.byteLength).toBe(48044);
  });
  it("clips what goes past the range", () => {
    const view = new DataView(encodeWav(Float32Array.of(2, -2, 0.5), TARGET_RATE));
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([32767, -32768, 16383]);
  });
  it("joins chunks in order", () => {
    expect([...joinChunks([Float32Array.of(1, 2), Float32Array.of(3)])]).toEqual([1, 2, 3]);
  });
  it("does not resample what is already at the target rate", async () => {
    const samples = Float32Array.of(1);
    expect(await resample(samples, TARGET_RATE)).toBe(samples);
  });
  it("renders at the target rate and length", async () => {
    const made: number[][] = [];
    class Offline {
      destination = {};
      constructor(channels: number, length: number, rate: number) { made.push([channels, length, rate]); }
      createBufferSource() { return { connect: () => {}, start: () => {}, buffer: null }; }
      createBuffer() { return { copyToChannel: () => {} }; }
      async startRendering() { return { getChannelData: () => new Float32Array(24000) }; }
    }
    const out = await resample(new Float32Array(48000), 48000, 24000, Offline as unknown as typeof OfflineAudioContext);
    expect(made).toEqual([[1, 24000, 24000]]);
    expect(out.length).toBe(24000);
  });
});

describe("the upload", () => {
  function fakeXhr(status: number, body: string) {
    const xhr = { upload: {} as { onload?: () => void }, open: vi.fn(), setRequestHeader: vi.fn(), status, responseText: body } as unknown as XMLHttpRequest & { send: unknown };
    xhr.send = vi.fn(() => { (xhr.upload as unknown as { onload?: () => void }).onload?.(); xhr.onload?.({} as ProgressEvent); });
    return xhr;
  }
  const options = { url: "http://x/v", token: "t", apikey: "k", wav: new ArrayBuffer(4), onSent: () => {} };
  it("says when the body left and returns the transcript", async () => {
    const onSent = vi.fn();
    const xhr = fakeXhr(200, JSON.stringify({ clip_id: "c", transcript: "hola", duration_ms: 1 }));
    await expect(uploadWav({ ...options, onSent, makeRequest: () => xhr })).resolves.toMatchObject({ transcript: "hola" });
    expect(onSent).toHaveBeenCalledOnce();
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("Content-Type", "audio/wav");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer t");
  });
  it("gives the server's code", async () => {
    await expect(uploadWav({ ...options, makeRequest: () => fakeXhr(429, JSON.stringify({ error: "voice_quota" })) })).rejects.toThrow("voice_quota");
  });
  it("a body it cannot read is a plain failure", async () => {
    await expect(uploadWav({ ...options, makeRequest: () => fakeXhr(502, "<html>") })).rejects.toThrow("voice_failed");
  });
  it("a network error is retryable", async () => {
    const xhr = fakeXhr(0, "");
    xhr.send = vi.fn(() => { xhr.onerror?.({} as ProgressEvent); });
    await expect(uploadWav({ ...options, makeRequest: () => xhr })).rejects.toThrow("network");
  });
});

describe("the thread", () => {
  const m = (id: string, seq: number): PersonMessage => ({ id, seq, workspace_id: "w", direction: "in", channel: "surface", kind: "text", body: id, forwarded: false, outcome: null, created_at: "" });
  it("a row that arrives twice is one row", () => {
    expect(mergeMessages([m("a", 1)], [m("a", 1), m("b", 2)]).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("the server's order wins over the order of arrival", () => {
    expect(mergeMessages([m("b", 2)], [m("a", 1)]).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("an update replaces the row", () => {
    expect(mergeMessages([m("a", 1)], [{ ...m("a", 1), outcome: { kind: "note_saved" } }])[0].outcome?.kind).toBe("note_saved");
  });
});

it.each(["account", "workspace"])("discards old conversation data after switching %s", async (kind) => {
  const api = await import("@/lib/agentClient");
  const { useAgentConversation } = await import("@/lib/agentConversation");
  const pending: ((data: { data: PersonMessage[] }) => void)[] = [];
  const query = { select: () => query, eq: () => query, order: () => query, limit: () => new Promise((resolve) => pending.push(resolve as typeof pending[number])) };
  const spy = vi.spyOn(api, "getAgentClient").mockReturnValue({ from: () => query } as unknown as ReturnType<typeof api.getAgentClient>);
  const first = useAgentConversation.getState().subscribe("w", "alice");
  useAgentConversation.setState({ failed: { clientId: "old", body: "Alice secret", context: {} } });
  first();
  const release = useAgentConversation.getState().subscribe(kind === "workspace" ? "other" : "w", kind === "account" ? "bob" : "alice");
  try {
    expect(useAgentConversation.getState().failed).toBeNull();
    pending[0]({ data: [{ id: "secret", seq: 1, workspace_id: "w", direction: "in", channel: "surface", kind: "text", body: "Alice secret", forwarded: false, outcome: null, created_at: "" }] });
    await Promise.resolve();
    expect(useAgentConversation.getState().messages).toEqual([]);
  } finally { release(); spy.mockRestore(); }
});
