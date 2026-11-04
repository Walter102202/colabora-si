import { expect, it } from "vitest";
import { startStubProvider } from "./voice-stub-provider.mjs";

it("the voice stub returns session-scoped turns only for endpointing and diarization", async () => {
  const provider = await startStubProvider({ port: 0 });
  try {
    for (const mode of ["DIARIZATION", "ENDPOINTING", "PUSH_TO_TALK", "invalid"]) {
      const wav = Buffer.alloc(32044);
      wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write("data", 36); wav.writeUInt32LE(32000, 40);
      const request = JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode });
      const body = Buffer.concat([Buffer.from(`--test\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${request}\r\n--test\r\nContent-Disposition: form-data; name="audio"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n`), wav, Buffer.from("\r\n--test--\r\n")]);
      provider.script.push({ transcript: "Hello" });
      const res = await fetch(`${provider.url}/v1/asr/transcribe?sessionId=meeting-1`, {
        method: "POST", headers: { Authorization: "Bearer stub", "Content-Type": "multipart/form-data; boundary=test" }, body,
      });
      expect(res.status).toBe(mode === "invalid" ? 400 : 200);
      if (mode === "invalid") continue;
      const result = await res.json();
      expect(result).toMatchObject({ sessionId: "meeting-1", transcript: "Hello", audioDurationMs: 1000 });
      expect(result.turns).toEqual(mode === "PUSH_TO_TALK" ? [] : [{ turnId: "0", startMs: 0, endMs: 1000, transcript: "Hello", ...(mode === "DIARIZATION" ? { speaker: "A" } : {}) }]);
    }
  } finally { await provider.stop(); }
});
