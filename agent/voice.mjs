// Turns a chat voice note into text: Ogg to the WAV the transcription model takes, then one call to voice-transcribe.
// The audio exists on this host only inside a temporary folder that is removed right after.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @param {string} bin @param {string[]} args @param {number} timeoutMs */
function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"], timeout: timeoutMs, killSignal: "SIGKILL" });
    child.once("error", (e) => reject(Object.assign(new Error("no_ffmpeg"), { cause: e })));
    child.once("close", (code) => (code === 0 ? resolve(undefined) : reject(new Error("failed"))));
  });
}

/**
 * The input format is fixed and only local files are allowed, so a crafted file cannot make ffmpeg read anything else.
 * @param {Uint8Array} ogg @param {{ffmpeg?: string, timeoutMs?: number}} [opts]
 */
export async function oggToWav(ogg, { ffmpeg = "ffmpeg", timeoutMs = 60_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "colabora-voice-"));
  try {
    const input = join(dir, "in.ogg"), output = join(dir, "out.wav");
    await writeFile(input, ogg);
    await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-f", "ogg", "-i", input,
      "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-bitexact", "-t", "601", output], timeoutMs);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * @param {{
 *   url: string,
 *   accessToken: (fresh?: boolean) => Promise<string>,
 *   download: (fileId: string) => Promise<Uint8Array>,
 *   ffmpeg?: string, fetchImpl?: typeof fetch, retryMs?: number, convert?: typeof oggToWav,
 * }} opts
 */
export function createVoiceClient({ url, accessToken, download, ffmpeg = "ffmpeg", fetchImpl = globalThis.fetch, retryMs = 5000, convert = oggToWav }) {
  /** @param {import("./inbox.mjs").ChannelMessage} m */
  return async function transcribe(m) {
    const wav = await convert(await download(/** @type {{fileId: string}} */ (m.voice).fileId), { ffmpeg });
    const query = new URLSearchParams({ channel: "telegram", chat_id: m.chatId, message_id: String(m.messageId), forwarded: m.forwarded ? "1" : "0", lang: m.lang });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchImpl(`${url}?${query}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessToken(attempt > 0)}`, "Content-Type": "audio/wav" },
        body: wav,
        signal: AbortSignal.timeout(140_000),
      });
      if (res.ok) return /** @type {{duplicate?: boolean, clip_id?: string, transcript?: string}} */ (await res.json());
      const code = (await res.json().catch(() => ({}))).error ?? "failed";
      if (attempt === 0 && res.status === 401) continue;
      if (attempt === 0 && code === "voice_busy") {
        await new Promise((r) => setTimeout(r, retryMs));
        continue;
      }
      throw new Error(code);
    }
    throw new Error("failed");
  };
}
