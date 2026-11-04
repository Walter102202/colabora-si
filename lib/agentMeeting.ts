import { encodeWav, joinChunks, resample, uploadWav } from "@/lib/agentVoice";
import { ensurePageBodies } from "@/lib/pageBodies";
import { useStore } from "@/lib/store";
import type { Block } from "@/lib/types";

export interface Turn { startMs: number; endMs: number; speaker?: string; text: string }
export interface Segment {
  meetingId: string; n: number; startMs: number; durationMs: number; wav: Blob;
  status: "pending" | "transcribed" | "written"; turns?: Turn[];
}
export interface MeetingRecorder { stop(): Promise<void>; cancel(): void; elapsedMs(): number }
export interface MeetingRecorderOptions {
  meetingId: string; onSegment(seg: Segment): void | Promise<void>; onLevel(rms: number): void;
  maxMs?: number; stream?: MediaStream;
  onStop?(reason: "limit" | "stopped"): void;
  onError?(error: unknown): void;
}

async function database(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open("colabora-meetings", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("segments", { keyPath: ["meetingId", "n"] });
      store.createIndex("meetingId", "meetingId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("segments", mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("meeting_storage_failed"));
      try { run(tx.objectStore("segments"), (result) => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}
async function segments(meetingId: string): Promise<Segment[]> {
  return transaction("readonly", (store, done) => {
    const req = store.index("meetingId").getAll(meetingId);
    req.onsuccess = () => done((req.result as Segment[]).filter((s) => s.meetingId === meetingId).sort((a, b) => a.n - b.n));
  });
}
export async function listPendingSegments(meetingId: string): Promise<Segment[]> {
  return (await segments(meetingId)).filter((s) => s.status !== "written");
}
export async function markSegment(meetingId: string, n: number, status: Segment["status"], turns?: Turn[]): Promise<void> {
  return transaction("readwrite", (store) => {
    const req = store.get([meetingId, n]);
    req.onsuccess = () => {
      if (req.result) store.put({ ...req.result, status, ...(turns ? { turns } : {}), ...(status === "written" ? { wav: new Blob() } : {}) });
    };
  });
}
export async function deleteMeetingSegments(meetingId: string): Promise<void> {
  return transaction("readwrite", (store) => {
    const req = store.index("meetingId").getAll(meetingId);
    req.onsuccess = () => { for (const seg of req.result as Segment[]) if (seg.meetingId === meetingId) store.delete([meetingId, seg.n]); };
  });
}

const WORKLET = `class MeetingCapture extends AudioWorkletProcessor {
  process(inputs) { const frame = inputs[0]?.[0]; if (frame) this.port.postMessage(frame.slice()); return true; }
} registerProcessor("meeting-capture", MeetingCapture);`;

export async function startMeetingRecorder(opts: MeetingRecorderOptions): Promise<MeetingRecorder> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw new Error("unsupported");
  const maxMs = opts.maxMs ?? 3_600_000;
  if (!Number.isFinite(maxMs) || maxMs <= 0 || maxMs > 3_600_000) throw new Error("invalid_duration");
  // Never overwrite segments left by an interrupted session.
  let previous: Segment[];
  try { previous = await segments(opts.meetingId); }
  catch (error) { opts.stream?.getTracks().forEach((track) => track.stop()); throw error; }
  let n = previous.reduce((last, seg) => Math.max(last, seg.n + 1), 0);
  const previousMs = previous.reduce((last, seg) => Math.max(last, seg.startMs + seg.durationMs), 0);
  if (previousMs >= maxMs) {
    opts.stream?.getTracks().forEach((track) => track.stop());
    throw new Error("voice_too_long");
  }
  let stream: MediaStream;
  try { stream = opts.stream ?? await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
  catch (error) { throw new Error((error as DOMException)?.name === "NotFoundError" ? "no_mic" : "mic_denied"); }
  let context: AudioContext | undefined, node: AudioWorkletNode | undefined, source: MediaStreamAudioSourceNode | undefined;
  let stopped = false, cancelled = false, failure: unknown, stopTask: Promise<void> | undefined;
  let frames: Float32Array[] = [], samples = 0, totalSamples = 0, silenceMs = 0;
  let windowSamples = 0, windowSquares = 0;
  let queue = Promise.resolve();
  const deliveries: Promise<void>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (timer) clearTimeout(timer);
    if (node) { node.port.onmessage = null; node.disconnect(); node.port.close(); }
    source?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
  };
  const failed = (error: unknown) => {
    if (failure) return;
    failure = error;
    if (!stopped) { stopped = true; close(); }
    opts.onError?.(error);
  };
  try {
    context = new AudioContext();
    await context.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    node = new AudioWorkletNode(context, "meeting-capture", { numberOfOutputs: 0 });
    source = context.createMediaStreamSource(stream);
    const rate = context.sampleRate, windowSize = Math.round(rate / 10);
    const elapsedMs = () => previousMs + totalSamples * 1000 / rate;
    const cut = () => {
      if (!samples) return;
      const captured = frames, count = samples, index = n++, startMs = elapsedMs() - count * 1000 / rate;
      frames = []; samples = 0; silenceMs = 0;
      queue = queue.then(async () => {
        if (cancelled || failure) return;
        const wav = new Blob([encodeWav(await resample(joinChunks(captured), rate, 16000), 16000)], { type: "audio/wav" });
        const segment: Segment = { meetingId: opts.meetingId, n: index, startMs, durationMs: count * 1000 / rate, wav, status: "pending" };
        await transaction<void>("readwrite", (store) => { store.put(segment); });
        captured.length = 0;
        if (!cancelled) deliveries.push(Promise.resolve().then(() => opts.onSegment(segment)).catch(failed));
      }).catch(failed);
    };
    const finish = (reason: "limit" | "stopped") => {
      if (stopTask) return stopTask;
      if (!stopped) { stopped = true; close(); cut(); }
      stopTask = queue.then(() => Promise.all(deliveries)).then(() => { if (failure) throw failure; if (!cancelled) opts.onStop?.(reason); });
      return stopTask;
    };
    node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (stopped) return;
      let at = 0;
      while (at < data.length && !stopped) {
        const remaining = Math.max(0, Math.floor((maxMs - previousMs) * rate / 1000) - totalSamples);
        const size = Math.min(data.length - at, windowSize - windowSamples, remaining);
        if (!size) { void finish("limit").catch(failed); break; }
        const part = data.slice(at, at + size); frames.push(part);
        for (const value of part) windowSquares += value * value;
        at += size; windowSamples += size; samples += size; totalSamples += size;
        if (windowSamples === windowSize) {
          const rms = Math.sqrt(windowSquares / windowSamples);
          silenceMs = rms < .01 ? silenceMs + 100 : 0;
          windowSamples = 0; windowSquares = 0; opts.onLevel(rms);
          if (samples * 1000 / rate >= 120000 || (samples * 1000 / rate >= 45000 && silenceMs >= 700)) cut();
        }
        if (elapsedMs() >= maxMs) void finish("limit").catch(failed);
      }
    };
    source.connect(node);
    timer = setTimeout(() => { void finish("limit").catch(failed); }, maxMs - previousMs);
    return { stop: () => finish("stopped"), elapsedMs, cancel: () => {
      cancelled = true; frames = [];
      if (!stopped) { stopped = true; close(); }
    } };
  } catch (error) { close(); throw error; }
}

export async function transcribeSegment(seg: Segment, ctx: {
  url: string; token: string; apikey: string; workspaceId: string; lang: string; mode: "diarization" | "endpointing";
}): Promise<Turn[]> {
  const url = new URL(ctx.url);
  for (const [key, value] of Object.entries({ channel: "meeting", workspace_id: ctx.workspaceId, chat_id: seg.meetingId,
    session_id: seg.meetingId, mode: ctx.mode, lang: ctx.lang })) url.searchParams.set(key, value);
  const wav = await seg.wav.arrayBuffer();
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await uploadWav({ ...ctx, url: url.toString(), wav, onSent: () => {} }) as Awaited<ReturnType<typeof uploadWav>> & { turns?: Turn[] };
      if (!Array.isArray(result.turns)) throw new Error("voice_failed");
      return result.turns;
    } catch (error) {
      if (attempt || !["voice_busy", "network"].includes((error as Error).message)) throw error;
    }
  }
}

export function mergeTurns(turns: Turn[], offsetMs: number): Turn[] {
  const result: Turn[] = [];
  for (const turn of turns) {
    const next = { ...turn, startMs: turn.startMs + offsetMs, endMs: turn.endMs + offsetMs };
    const last = result.at(-1);
    if (last && last.speaker === next.speaker && next.startMs >= last.endMs && next.startMs - last.endMs < 1500) {
      last.endMs = next.endMs; last.text += ` ${next.text}`;
    } else result.push(next);
  }
  return result;
}
type TranscriptBlock = Block & { turn?: { meetingId: string; tMs: number; speaker?: string } };
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function turnsToBlocks(turns: Turn[], meetingId: string): TranscriptBlock[] {
  return turns.map((turn, index) => {
    const seconds = Math.floor(turn.startMs / 1000), time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    return { id: `meeting:${meetingId}:${turn.startMs}:${index}`, type: "paragraph", indent: 0,
      html: `${turn.speaker ? `<strong>${escape(turn.speaker)}</strong> ` : ""}[${time}] ${escape(turn.text)}`,
      turn: { meetingId, tMs: turn.startMs, ...(turn.speaker ? { speaker: turn.speaker } : {}) },
      attr: { by: "human", id: useStore.getState().syncUserId ?? "local", at: Date.now() } };
  });
}
export async function appendTranscript(pageId: string, meetingId: string, blocks: Block[]): Promise<void> {
  const initial = useStore.getState(), parentId = initial.pages[pageId]?.parentId;
  if (await ensurePageBodies(parentId ? [pageId, parentId] : [pageId]) !== "ready") throw new Error("meeting_page_unavailable");
  const state = useStore.getState(), page = state.pages[pageId];
  if (!page || page.isDeleted || state.syncUserId !== initial.syncUserId || state.syncWorkspaceId !== initial.syncWorkspaceId) throw new Error("meeting_page_unavailable");
  const existing = page.blocks as TranscriptBlock[], ids = new Set(existing.map((b) => b.id));
  const added = (blocks as TranscriptBlock[]).filter((b) => !ids.has(b.id));
  const heading = existing.findIndex((b) => b.key === `meeting:transcript:${meetingId}`);
  if (heading < 0) throw new Error("meeting_transcript_missing");
  const isTurn = (b: TranscriptBlock) => b.turn?.meetingId === meetingId;
  const transcript = [...existing.filter(isTurn), ...added].sort((a, b) => (a.turn?.tMs ?? 0) - (b.turn?.tMs ?? 0));
  const next = existing.filter((b) => !isTurn(b));
  next.splice(next.findIndex((b) => b.id === existing[heading].id) + 1, 0, ...transcript);
  if (added.length) state.setBlocks(pageId, next);
  const db = parentId ? state.pages[parentId]?.database : undefined, row = db?.rows.find((r) => r.pageId === pageId);
  if (db && row && parentId) {
    const duration = db.properties.find((p) => p.name === "Duration" && p.type === "number");
    const status = db.properties.find((p) => p.name === "Status" && p.type === "status");
    if (duration) {
      const recorded = await segments(meetingId);
      const current = useStore.getState();
      if (current.syncUserId !== state.syncUserId || current.syncWorkspaceId !== state.syncWorkspaceId) throw new Error("meeting_page_unavailable");
      current.updateCell(parentId, row.id, duration.id, Math.max(0, ...recorded.map((seg) => seg.startMs + seg.durationMs)) / 60000);
    }
    const recording = status?.options?.find((o) => o.name === "Recording");
    if (status && recording) state.updateCell(parentId, row.id, status.id, recording.id);
  }
}
