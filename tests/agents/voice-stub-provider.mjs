// A strict stand-in for the transcription provider: it answers only what the documented contract allows. For local
// checks. It holds no audio after answering.
import { createServer } from "node:http";

/** @param {Buffer} b */
function wavProblem(b) {
  if (b.length < 44 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return "not RIFF";
  const fmt = b.indexOf("fmt ", 12, "latin1");
  if (fmt < 0) return "no fmt";
  const channels = b.readUInt16LE(fmt + 10), rate = b.readUInt32LE(fmt + 12), bits = b.readUInt16LE(fmt + 22);
  if (b.readUInt16LE(fmt + 8) !== 1 || channels !== 1 || bits !== 16 || ![16000, 24000].includes(rate)) return "not mono 16-bit at 16 or 24 kHz";
  return null;
}

/** @param {{port: number, key?: string}} opts */
export function startStubProvider({ port, key = "stub" }) {
  /** @type {{transcript?: string, status?: number}[]} */
  const script = [];
  const seen = { requests: 0, ok: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const answer = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      seen.requests++;
      if (req.method !== "POST" || !req.url?.startsWith("/v1/asr/transcribe")) return answer(404, { error: { message: "no route" } });
      if (req.headers.authorization !== `Bearer ${key}`) return answer(401, { error: { message: "bad key" } });
      const type = String(req.headers["content-type"] ?? "");
      if (!type.startsWith("multipart/form-data")) return answer(400, { error: { message: "not multipart" } });
      const raw = Buffer.concat(chunks);
      if (!raw.includes('name="request"\r\nContent-Type: application/json\r\n\r\n')) return answer(400, { error: { message: "the request part takes no filename" } });
      const form = await new Request("http://stub/", { method: "POST", headers: { "content-type": type }, body: raw }).formData();
      const request = form.get("request"), audio = form.get("audio");
      if (typeof request !== "string" || !(audio instanceof File)) return answer(400, { error: { message: "missing part" } });
      const r = JSON.parse(request);
      if (r.model !== "muse-voice-transcribe-1.0" || r.audioEncoding !== "WAV" || audio.type !== "audio/wav") {
        return answer(400, { error: { message: "bad request part" } });
      }
      const wav = Buffer.from(await audio.arrayBuffer());
      const problem = wavProblem(wav);
      if (problem) return answer(400, { error: { message: problem } });
      const step = script.shift() ?? { transcript: "" };
      if (step.status) return answer(step.status, { error: { message: "scripted failure", type: "server_error" } });
      seen.ok++;
      const data = wav.indexOf("data", 12, "latin1");
      answer(200, { sessionId: "stub", transcript: step.transcript, audioDurationMs: Math.floor(((wav.length - data - 8) / wav.readUInt32LE(wav.indexOf("fmt ", 12, "latin1") + 12) / 2) * 1000), turns: [] });
    });
  });
  return new Promise((resolve) => server.listen(port, "0.0.0.0", () => resolve({ script, seen, stop: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}
