// @vitest-environment happy-dom
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeIndexedDb } from "../clone/fakeIndexedDb";
import { createBlock, createPage } from "@/lib/factories";
import { useStore } from "@/lib/store";
import { appendTranscript, deleteMeetingSegments, listPendingSegments, markSegment, mergeTurns, startMeetingRecorder, transcribeSegment, turnsToBlocks, type Segment } from "@/lib/agentMeeting";

vi.mock("@/lib/pageBodies", () => ({ ensurePageBodies: vi.fn(async () => "ready") }));
vi.mock("@/lib/agentVoice", async (original) => ({ ...await original<typeof import("@/lib/agentVoice")>(), uploadWav: vi.fn() }));
import { uploadWav } from "@/lib/agentVoice";

// The existing fake supports scalar keys; adapt only its boundary for compound keys.
function disk() {
  const fake = installFakeIndexedDb();
  const open = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, "open").mockImplementation((name, version) => {
    const request = open(name, version);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      const create = db.createObjectStore.bind(db);
      db.createObjectStore = (name) => create(name);
    });
    request.addEventListener("success", () => {
      const db = request.result;
      const transaction = db.transaction.bind(db);
      db.transaction = (...args) => {
        const tx = transaction(...args), objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name) => {
          const store = objectStore(name), put = store.put.bind(store), get = store.get.bind(store), remove = store.delete.bind(store);
          store.put = (value) => put(value, JSON.stringify([value.meetingId, value.n]));
          store.get = (key) => get(JSON.stringify(key));
          store.delete = (key) => remove(JSON.stringify(key));
          return store;
        };
        return tx;
      };
    });
    return request;
  });
  return fake;
}
function microphone() {
  let send: (event: { data: Float32Array }) => void = () => {};
  const stop = vi.fn(), close = vi.fn(async () => {});
  class Context {
    sampleRate = 16000;
    resume = async () => {};
    close = close;
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  }
  class Worklet {
    port = { set onmessage(fn: typeof send) { send = fn; }, close: vi.fn() };
    disconnect = vi.fn();
  }
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:worklet");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { stop, close, frames(seconds: number, level = .2) {
    for (let n = 0; n < Math.round(seconds * 10); n++) send?.({ data: new Float32Array(1600).fill(level) });
  } };
}
beforeEach(() => { vi.stubGlobal("Blob", NativeBlob); disk(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("durable segmented recording", () => {
  it.each(["silence", "hard"])("cuts at %s, commits before callbacks and retains recovery state", async (cut) => {
    const mic = microphone(), received: Segment[] = [];
    const recorder = await startMeetingRecorder({ meetingId: "m", onLevel: vi.fn(), onSegment: async (seg) => {
      expect((await listPendingSegments("m")).some((s) => s.n === seg.n)).toBe(true);
      received.push(seg);
    } });
    if (cut === "silence") { mic.frames(45); mic.frames(.7, 0); }
    else mic.frames(120);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ n: 0, startMs: 0, durationMs: cut === "silence" ? 45700 : 120000, status: "pending" });
    const header = new DataView(await received[0].wav.arrayBuffer());
    expect(header.getUint32(24, true)).toBe(16000);
    mic.frames(1);
    await recorder.stop();
    expect(received[1].startMs).toBe(received[0].durationMs);
    expect(mic.stop).toHaveBeenCalledOnce();
    await markSegment("m", 0, "transcribed", [{ startMs: 0, endMs: 20, text: "hello" }]);
    expect((await listPendingSegments("m"))[0].turns?.[0].text).toBe("hello");
    await markSegment("m", 0, "written");
    expect((await listPendingSegments("m")).map((s) => s.n)).toEqual([1]);
    await deleteMeetingSegments("m");
    expect(await listPendingSegments("m")).toEqual([]);
  });
  it("persists the next segment while delivery is stalled and resumes after written silence", async () => {
    const mic = microphone();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const recorder = await startMeetingRecorder({ meetingId: "resume", onLevel: vi.fn(), onSegment: () => waiting });
    mic.frames(120); mic.frames(120);
    await vi.waitFor(async () => expect(await listPendingSegments("resume")).toHaveLength(2));
    release();
    await recorder.stop();
    await markSegment("resume", 0, "written", []);
    await markSegment("resume", 1, "written", []);
    const resumed: Segment[] = [];
    const next = await startMeetingRecorder({ meetingId: "resume", onLevel: vi.fn(), onSegment: (seg) => { resumed.push(seg); } });
    expect(next.elapsedMs()).toBe(240000);
    mic.frames(1);
    await next.stop();
    expect(resumed[0]).toMatchObject({ n: 2, startMs: 240000, durationMs: 1000 });
    const cancelled = await startMeetingRecorder({ meetingId: "cancelled", onLevel: vi.fn(), onSegment: vi.fn() });
    mic.frames(1); cancelled.cancel();
    expect(await listPendingSegments("cancelled")).toEqual([]);
  });
  it("retains the current audio tail when a segment upload fails", async () => {
    const mic = microphone(), onError = vi.fn();
    let rejectUpload!: (error: Error) => void;
    const uploading = new Promise<void>((_resolve, reject) => { rejectUpload = reject; });
    const onSegment = vi.fn(() => uploading);
    const recorder = await startMeetingRecorder({ meetingId: "upload-failed", onLevel: vi.fn(), onSegment, onError });
    mic.frames(120);
    await vi.waitFor(() => expect(onSegment).toHaveBeenCalledOnce());
    mic.frames(12);
    rejectUpload(new Error("network"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await expect(recorder.stop()).rejects.toThrow("network");
    const saved = await listPendingSegments("upload-failed");
    expect(saved.map((seg) => [seg.n, seg.startMs, seg.durationMs])).toEqual([[0, 0, 120000], [1, 120000, 12000]]);
    expect(saved[1].wav.size).toBe(44 + 12000 * 32);
    expect(onSegment).toHaveBeenCalledOnce();
    expect(mic.stop).toHaveBeenCalledOnce();
  });
  it.each(["unsupported", "invalid_duration"])("releases a supplied stream on early %s rejection", async (reason) => {
    const mic = microphone();
    const stream = { getTracks: () => [{ stop: mic.stop }] } as unknown as MediaStream;
    if (reason === "unsupported") vi.stubGlobal("AudioWorkletNode", undefined);
    await expect(startMeetingRecorder({ meetingId: "invalid", stream, maxMs: reason === "invalid_duration" ? 0 : 1000,
      onLevel: vi.fn(), onSegment: vi.fn() })).rejects.toThrow(reason);
    expect(mic.stop).toHaveBeenCalledOnce();
  });
  it("stops at the duration cap and reports persistence failures without invoking upload", async () => {
    const mic = microphone(), onStop = vi.fn(), onSegment = vi.fn();
    const recorder = await startMeetingRecorder({ meetingId: "limit", maxMs: 1000, onLevel: vi.fn(), onSegment, onStop });
    mic.frames(2);
    await vi.waitFor(() => expect(onStop).toHaveBeenCalledWith("limit"));
    expect(recorder.elapsedMs()).toBe(1000);
    expect(onSegment).toHaveBeenCalledOnce();
    expect(mic.stop).toHaveBeenCalledOnce();
    const fake = disk(), onError = vi.fn(), upload = vi.fn();
    const broken = await startMeetingRecorder({ meetingId: "broken", onLevel: vi.fn(), onSegment: upload, onError });
    mic.frames(1);
    fake.failNext("QuotaExceededError");
    await expect(broken.stop()).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });
});

it("merges nearby same-speaker turns, offsets times and escapes attributed blocks", () => {
  const turns = mergeTurns([{ startMs: 0, endMs: 1000, speaker: "A", text: "one" },
    { startMs: 1200, endMs: 2000, speaker: "A", text: "<two>" },
    { startMs: 2100, endMs: 3000, speaker: "B", text: "three" }], 60000);
  expect(turns).toEqual([{ startMs: 60000, endMs: 62000, speaker: "A", text: "one <two>" },
    { startMs: 62100, endMs: 63000, speaker: "B", text: "three" }]);
  const blocks = turnsToBlocks(turns, "m");
  expect(blocks[0]).toMatchObject({ html: "<strong>A</strong> [01:00] one &lt;two&gt;", turn: { meetingId: "m", tMs: 60000, speaker: "A" }, attr: { by: "human" } });
  expect(turnsToBlocks(turns, "m").map((b) => b.id)).toEqual(blocks.map((b) => b.id));
});

it("recovery appends in chronological order once without overwriting notes", async () => {
  const heading = createBlock("heading2", { key: "meeting:transcript:m" });
  const notes = createBlock("paragraph", { html: "my notes" });
  useStore.setState({ pages: { p: createPage({ id: "p", blocks: [heading, notes] }) } });
  const early = turnsToBlocks([{ startMs: 0, endMs: 100, text: "early" }], "m");
  const late = turnsToBlocks([{ startMs: 60000, endMs: 61000, text: "late" }], "m");
  await appendTranscript("p", "m", late);
  await appendTranscript("p", "m", early);
  await appendTranscript("p", "m", late);
  expect(useStore.getState().pages.p.blocks.map((b) => b.id)).toEqual([heading.id, early[0].id, late[0].id, notes.id]);
});

it.each(["voice_busy", "network", "voice_quota", "budget_exceeded"])("upload retries only transient %s", async (code) => {
  const upload = vi.mocked(uploadWav);
  upload.mockRejectedValueOnce(new Error(code)).mockResolvedValue({ clip_id: "c", transcript: "hello", duration_ms: 1000, turns: [] } as never);
  const seg: Segment = { meetingId: "m", n: 0, startMs: 0, durationMs: 1000, wav: new Blob([new Uint8Array(10)]), status: "pending" };
  const result = transcribeSegment(seg, { url: "http://local/voice-transcribe", token: "t", apikey: "k", workspaceId: "w", lang: "en", mode: "diarization" });
  if (code === "voice_quota" || code === "budget_exceeded") { await expect(result).rejects.toThrow(code); expect(upload).toHaveBeenCalledTimes(1); }
  else { await expect(result).resolves.toEqual([]); expect(upload).toHaveBeenCalledTimes(2); }
  const url = new URL(upload.mock.calls[0][0].url);
  expect(url.searchParams.get("session_id")).toBe("m");
  expect(url.searchParams.get("channel")).toBe("meeting");
});
