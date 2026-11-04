// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "@/lib/types";
import type { MeetingRecorderOptions, Segment } from "@/lib/agentMeeting";
import MeetingBlock from "@/components/agents/meeting/MeetingBlock";

const mock = vi.hoisted(() => ({
  start: vi.fn(), pending: vi.fn(), mark: vi.fn(), remove: vi.fn(), transcribe: vi.fn(), append: vi.fn(), summary: vi.fn(), update: vi.fn(),
  requests: [] as { id: string; kind: string; state: string; request: { block_id: string } }[],
  state: {} as Record<string, unknown>,
}));
vi.mock("@/lib/agentMeeting", () => ({
  startMeetingRecorder: mock.start, listPendingSegments: mock.pending, markSegment: mock.mark, deleteMeetingSegments: mock.remove,
  transcribeSegment: mock.transcribe, appendTranscript: mock.append,
  mergeTurns: (turns: unknown) => turns, turnsToBlocks: (turns: unknown) => turns,
}));
vi.mock("@/lib/agentAiRequests", () => ({ requestMeetingSummary: mock.summary, useAiRequests: () => mock.requests }));
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "token" } } }) } }) }));
vi.mock("@/lib/store", () => ({ useStore: Object.assign((select: (s: unknown) => unknown) => select(mock.state), { getState: () => mock.state }) }));
let host: HTMLDivElement, root: Root, block: Block, options: MeetingRecorderOptions;
let durable: Segment[];
const segment = (n: number): Segment => ({ meetingId: "m", n, startMs: n * 60000, durationMs: 60000, status: "pending", wav: new Blob(["wav"]) });
const stop = vi.fn(), cancel = vi.fn();
async function render(readOnly = false) { await act(async () => { root.render(createElement(MeetingBlock, { pageId: "p", block, readOnly })); }); }
async function click(label: string) { const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(button).not.toBeNull(); await act(async () => { button!.click(); }); }
beforeEach(() => {
  vi.clearAllMocks(); durable = []; mock.requests = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv("VITE_SUPABASE_URL", "https://local.test"); vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "public");
  block = { id: "m", type: "meeting", html: "", indent: 0, meeting: { id: "m", status: "idle" } };
  mock.state = { syncWorkspaceId: "ws", syncUserId: "u", pages: { p: { blocks: [block], locked: false, isDeleted: false } }, updateBlock: mock.update };
  mock.update.mockImplementation((_page: string, _id: string, patch: Partial<Block>) => { Object.assign(block, patch); });
  mock.pending.mockImplementation(async () => durable.filter((s) => s.status !== "written"));
  mock.mark.mockImplementation(async (_id: string, n: number, status: Segment["status"], turns?: Segment["turns"]) => { Object.assign(durable.find((s) => s.n === n)!, { status, turns }); });
  mock.remove.mockImplementation(async () => { durable = []; });
  mock.transcribe.mockResolvedValue([{ startMs: 0, endMs: 1000, text: "Hello" }]); mock.append.mockResolvedValue(undefined);
  mock.summary.mockResolvedValue({ taskId: "request" });
  stop.mockImplementation(async () => { for (const seg of durable) await options.onSegment(seg); options.onStop?.("stopped"); });
  mock.start.mockImplementation(async (opts: MeetingRecorderOptions) => { options = opts; return { stop, cancel, elapsedMs: () => 120000 }; });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllEnvs(); });

it("starts with consent, drains two segments before summary, and follows completion", async () => {
  await render(); expect(host.textContent).toContain("Tell the participants you are recording");
  await click("Start recording"); expect(host.textContent).toContain("Recording");
  durable = [segment(0), segment(1)]; await click("Stop");
  expect(mock.transcribe).toHaveBeenCalledTimes(2); expect(mock.append).toHaveBeenCalledTimes(2);
  expect(mock.mark.mock.calls.filter((call) => call[2] === "written")).toHaveLength(2);
  expect(mock.summary).toHaveBeenCalledWith("p", "m", expect.any(String));
  expect(mock.summary.mock.invocationCallOrder[0]).toBeGreaterThan(mock.append.mock.invocationCallOrder[1]);
  expect(host.textContent).toContain("Trama is summarizing");
  mock.requests = [{ id: "request", kind: "meeting", state: "done", request: { block_id: "m" } }]; await render();
  expect(block.meeting?.status).toBe("ready"); expect(host.textContent).toContain("Summary");
});
it("recovers persisted transcription without uploading it again", async () => {
  durable = [{ ...segment(0), status: "transcribed", turns: [{ startMs: 0, endMs: 1000, text: "Saved" }] }];
  block.meeting!.status = "recording"; await render();
  expect(host.textContent).toContain("1 minutes recovered"); expect(mock.transcribe).not.toHaveBeenCalled();
  expect(mock.append).toHaveBeenCalledTimes(1); expect(mock.summary).toHaveBeenCalledTimes(1);
});
it("keeps quota failures recoverable and never summarizes before all writes", async () => {
  durable = [segment(0), segment(1)]; mock.transcribe.mockRejectedValueOnce(new Error("voice_quota")); await render();
  expect(host.textContent).toContain("quota"); expect(mock.summary).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled();
  await click("Retry"); expect(mock.append).toHaveBeenCalledTimes(2); expect(mock.summary).toHaveBeenCalledTimes(1);
});
it("explains microphone denial and permits another attempt", async () => {
  mock.start.mockRejectedValueOnce(new Error("mic_denied")); await render(); await click("Start recording");
  expect(host.textContent).toContain("site settings"); expect(mock.summary).not.toHaveBeenCalled();
  await click("Retry"); expect(mock.start).toHaveBeenCalledTimes(2);
});
it.each(["readOnly", "locked", "nested"])("never recovers or records when %s", async (mode) => {
  durable = [segment(0)]; const p = (mock.state.pages as Record<string, { locked: boolean; blocks: Block[] }>).p;
  if (mode === "locked") p.locked = true; if (mode === "nested") p.blocks = [];
  await render(mode === "readOnly");
  expect(mock.pending).not.toHaveBeenCalled(); expect(mock.start).not.toHaveBeenCalled(); expect(mock.update).not.toHaveBeenCalled();
  expect(host.querySelector("button")).toBeNull();
});
it("stops on unmount and ignores callbacks after identity changes", async () => {
  await render(); await click("Start recording"); mock.update.mockClear();
  mock.state.syncUserId = "other"; durable = [segment(0)];
  await act(async () => { await options.onSegment(durable[0]); });
  expect(mock.append).not.toHaveBeenCalled(); expect(mock.update).not.toHaveBeenCalled();
  await act(async () => root.unmount()); expect(stop).toHaveBeenCalled(); root = createRoot(host);
});
it("reconciles a completed summary on reload without requesting it again", async () => {
  block.meeting = { id: "m", status: "summarizing", durationMs: 60000 };
  mock.requests = [{ id: "previous", kind: "meeting", state: "done", request: { block_id: "m" } }]; await render();
  expect(block.meeting.status).toBe("ready"); expect(mock.summary).not.toHaveBeenCalled();
});

it("retains unload protection on quota failure and removes it after recovery", async () => {
  durable = [segment(0)]; mock.transcribe.mockRejectedValueOnce(new Error("voice_quota")); await render();
  const before = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(before); expect(before.defaultPrevented).toBe(true);
  await click("Retry"); const after = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
});
it("retries a failed summary without uploading written audio", async () => {
  durable = [segment(0)]; mock.summary.mockRejectedValueOnce(new Error("network")); await render();
  expect(block.meeting?.status).toBe("failed"); expect(mock.transcribe).toHaveBeenCalledTimes(1);
  await click("Retry"); expect(mock.transcribe).toHaveBeenCalledTimes(1); expect(mock.summary).toHaveBeenCalledTimes(2);
});
it("finishes automatically after the recorder reaches its limit", async () => {
  await render(); await click("Start recording"); durable = [segment(0)];
  await act(async () => { await options.onSegment(durable[0]); options.onStop?.("limit"); });
  expect(mock.summary).toHaveBeenCalledTimes(1); expect(block.meeting?.status).toBe("summarizing");
});
it("closes a microphone granted after the component unmounts", async () => {
  let grant!: (value: { stop: typeof stop; cancel: typeof cancel; elapsedMs: () => number }) => void;
  mock.start.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
  await render(); await click("Start recording"); await act(async () => root.unmount()); mock.update.mockClear();
  stop.mockResolvedValueOnce(undefined);
  await act(async () => { grant({ stop, cancel, elapsedMs: () => 0 }); });
  expect(stop).toHaveBeenCalled(); expect(mock.update).not.toHaveBeenCalled(); root = createRoot(host);
});

it("waits for a pending transcript write before deleting audio or requesting a summary", async () => {
  let written!: () => void;
  mock.append.mockImplementationOnce(() => new Promise<void>((resolve) => { written = resolve; }));
  durable = [segment(0)]; await render();
  expect(mock.remove).not.toHaveBeenCalled(); expect(mock.summary).not.toHaveBeenCalled();
  await act(async () => written()); expect(mock.summary).toHaveBeenCalledTimes(1);
});
it("attaches to an existing request after an ambiguous summary retry", async () => {
  block.meeting = { id: "m", status: "failed", durationMs: 60000 };
  mock.summary.mockRejectedValueOnce(new Error("request_in_progress"));
  mock.requests = [{ id: "already", kind: "meeting", state: "working", request: { block_id: "m" } }];
  await render(); await click("Retry"); expect(block.meeting.status).toBe("summarizing");
  mock.requests = [{ ...mock.requests[0], state: "done" }]; await render(); expect(block.meeting.status).toBe("ready");
});
