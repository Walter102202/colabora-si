import { useEffect, useRef, useState } from "react";
import type { Block } from "@/lib/types";
import { useStore } from "@/lib/store";
import { getAgentClient } from "@/lib/agentClient";
import { requestMeetingSummary, useAiRequests } from "@/lib/agentAiRequests";
import { appendTranscript, deleteMeetingSegments, listPendingSegments, markSegment, mergeTurns, startMeetingRecorder, transcribeSegment, turnsToBlocks, type MeetingRecorder, type Segment } from "@/lib/agentMeeting";

type Meeting = NonNullable<Block["meeting"]>;
interface View { status: Meeting["status"]; duration: number; pending: number; level: number; minute: number; recovered: number; busy: boolean; error: string; requestId?: string }
const clock = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
function failureText(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return ({ mic_denied: "Microphone access was denied. Allow microphone access in your browser site settings, then retry.",
    no_mic: "No microphone found. Connect a microphone and retry.", unsupported: "This browser cannot record audio.",
    voice_quota: "The meeting transcription quota has been reached. Your audio is saved locally; retry later.",
    budget_exceeded: "The agent has reached its budget. Your audio is saved locally; retry after the budget is increased.",
    network: "The connection failed. Your audio is saved locally; retry when you are online.",
    summary_failed: "The meeting summary failed. Retry to ask Trama again.",
    sign_in: "Sign in to a workspace to transcribe this meeting.",
  } as Record<string, string>)[code] ?? "The meeting could not finish. Your pending audio is saved locally. Retry to continue.";
}

function session(pageId: string, block: Block, notify: (view: View) => void, allowed: () => boolean) {
  const id = block.id;
  let meta: Meeting = block.meeting ?? { id, status: "idle" };
  let view: View = { status: meta.status, duration: meta.durationMs ?? 0, pending: 0, level: 0, minute: 0, recovered: 0, busy: false, error: "" };
  let recorder: MeetingRecorder | undefined, queue = Promise.resolve(), failed = false, finishing = false, requestId: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const emit = (patch: Partial<View>) => { if (allowed()) { view = { ...view, ...patch }; notify(view); } };
  const persist = (patch: Partial<Meeting>) => {
    if (!allowed()) return;
    meta = { ...meta, ...patch };
    useStore.getState().updateBlock(pageId, id, { meeting: meta });
    emit({ status: meta.status, duration: meta.durationMs ?? view.duration });
  };
  const fail = (error: unknown) => { if (!allowed()) return; failed = true; finishing = false; if (timer) clearInterval(timer); const text = failureText(meta.status === "summarizing" ? new Error("summary_failed") : error); persist({ status: "failed" }); emit({ error: text, busy: false }); };
  const upload = async (seg: Segment) => {
    if (!allowed()) return;
    emit({ minute: seg.n + 1 });
    let turns = seg.turns;
    if (seg.status === "pending") {
      const auth = (await getAgentClient()?.auth.getSession())?.data.session;
      if (!allowed()) return;
      const workspaceId = useStore.getState().syncWorkspaceId;
      if (!auth || !workspaceId) throw new Error("sign_in");
      turns = await transcribeSegment(seg, { url: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/voice-transcribe`, token: auth.access_token,
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY, workspaceId,
        lang: meta.lang ?? (navigator.language.startsWith("en") ? "en" : "es"), mode: "diarization" });
      if (!allowed()) return;
      await markSegment(id, seg.n, "transcribed", turns);
    }
    if (!allowed()) return;
    await appendTranscript(pageId, id, turnsToBlocks(mergeTurns(turns ?? [], seg.startMs), id));
    if (!allowed()) return;
    persist({ durationMs: Math.max(meta.durationMs ?? 0, seg.startMs + seg.durationMs) });
    await markSegment(id, seg.n, "written");
    emit({ pending: Math.max(0, view.pending - 1) });
  };
  const enqueue = (seg: Segment, recovered = false) => {
    if (!allowed()) return Promise.resolve();
    if (!recovered) emit({ pending: view.pending + 1 });
    queue = queue.then(() => upload(seg));
    return queue;
  };
  const finish = async () => {
    if (!allowed() || failed || finishing) return;
    finishing = true;
    try {
      await queue;
      if (!allowed() || failed) return;
      if ((await listPendingSegments(id)).length) throw new Error("meeting_pending");
      if (!allowed()) return;
      persist({ endedAt: Date.now(), durationMs: meta.durationMs ?? 0 });
      await deleteMeetingSegments(id);
      if (!allowed()) return;
      if ((meta.durationMs ?? 0) < 60000) { persist({ status: "ready" }); emit({ busy: false }); return; }
      requestId = "pending";
      persist({ status: "summarizing" }); emit({ busy: false, requestId });
      const request = await requestMeetingSummary(pageId, id, meta.lang ?? (navigator.language.startsWith("en") ? "en" : "es"));
      requestId = request.taskId; emit({ requestId });
    } catch (error) {
      if (meta.status === "summarizing" && error instanceof Error && error.message === "request_in_progress") {
        requestId = undefined; emit({ requestId, busy: false });
      } else fail(error);
    }
  };
  const stop = async () => {
    if (!allowed() || view.busy) return;
    emit({ busy: true }); persist({ status: "transcribing" });
    if (timer) clearInterval(timer);
    try { await recorder?.stop(); await finish(); } catch (error) { fail(error); }
  };
  const start = async () => {
    if (!allowed() || view.busy) return;
    failed = false; finishing = false; queue = Promise.resolve(); emit({ busy: true, error: "" });
    try {
      const capture = await startMeetingRecorder({ meetingId: id, onLevel: (level) => emit({ level }),
        onSegment: (seg) => enqueue(seg), onError: fail,
        onStop: () => { if (timer) clearInterval(timer); if (allowed() && !failed) { persist({ status: "transcribing" }); void finish(); } } });
      if (!allowed()) { await capture.stop().catch(() => {}); return; }
      recorder = capture;
      persist({ status: "recording", startedAt: meta.startedAt ?? Date.now(), lang: meta.lang ?? (navigator.language.startsWith("en") ? "en" : "es") });
      emit({ busy: false });
      timer = setInterval(() => emit({ duration: capture.elapsedMs() }), 1000);
    } catch (error) { fail(error); }
  };
  const recover = async (retry = false) => {
    if (!allowed()) return;
    failed = false; finishing = false; queue = Promise.resolve(); emit({ busy: true, error: "" });
    try {
      // Stop capture before retrying any durable tail left by an upload failure.
      if (retry && recorder) { failed = true; await recorder.stop().catch(() => {}); recorder = undefined; failed = false; queue = Promise.resolve(); }
      const pending = await listPendingSegments(id);
      if (!allowed()) return;
      if (pending.length) {
        const duration = Math.max(meta.durationMs ?? 0, ...pending.map((seg) => seg.startMs + seg.durationMs));
        emit({ pending: pending.length, recovered: Math.ceil(duration / 60000) }); persist({ status: "transcribing", durationMs: duration });
        for (const seg of pending) await enqueue(seg, true);
        await finish();
      } else if (retry || meta.status === "recording" || meta.status === "transcribing") {
        if (!meta.startedAt && !(meta.durationMs ?? 0) && retry) { emit({ busy: false }); await start(); }
        else await finish();
      } else emit({ busy: false });
    } catch (error) { fail(error); }
  };
  return { start, stop, recover, reconcile(request: { id: string; state: string }) {
    if (!allowed() || view.status !== "summarizing" || (requestId && request.id !== requestId)) return;
    if (request.state === "done") { persist({ status: "ready" }); emit({ busy: false }); }
    else if (["failed", "cancelled"].includes(request.state)) fail(new Error("summary_failed"));
  }, dispose() { if (timer) clearInterval(timer); void recorder?.stop().catch(() => {}); } };
}

export default function MeetingBlock({ block, pageId, readOnly = false }: { block: Block; pageId: string; readOnly?: boolean }) {
  const userId = useStore((s) => s.syncUserId), workspaceId = useStore((s) => s.syncWorkspaceId);
  const page = useStore((s) => s.pages[pageId]);
  const [identity] = useState({ userId, workspaceId });
  const topLevel = !!page?.blocks.some((entry) => entry.id === block.id);
  const disabled = readOnly || !!page?.locked || !!page?.isDeleted || !topLevel || identity.userId !== userId || identity.workspaceId !== workspaceId;
  const [view, setView] = useState<View>({ status: block.meeting?.status ?? "idle", duration: block.meeting?.durationMs ?? 0, pending: 0, level: 0, minute: 0, recovered: 0, busy: false, error: "" });
  const controller = useRef<ReturnType<typeof session> | null>(null);
  const requests = useAiRequests(pageId);
  useEffect(() => {
    if (disabled) return;
    let active = true;
    const allowed = () => {
      const state = useStore.getState(), current = state.pages[pageId];
      return active && state.syncUserId === userId && state.syncWorkspaceId === workspaceId && !!current && !current.locked && !current.isDeleted && current.blocks.some((entry) => entry.id === block.id);
    };
    const latest = useStore.getState().pages[pageId]?.blocks.find((entry) => entry.id === block.id);
    if (!latest) return;
    const current = session(pageId, latest, setView, allowed); controller.current = current;
    void current.recover();
    return () => { active = false; controller.current = null; current.dispose(); };
  }, [pageId, block.id, disabled, userId, workspaceId]);
  useEffect(() => {
    const request = requests.find((entry) => entry.kind === "meeting" && entry.request.block_id === block.id && (!view.requestId || entry.id === view.requestId));
    if (request) controller.current?.reconcile(request);
  }, [requests, block.id, view.status, view.requestId]);
  useEffect(() => {
    if (disabled || !view.pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [disabled, view.pending]);
  const summary = () => {
    const heading = useStore.getState().pages[pageId]?.blocks.find((entry) => entry.key === `meeting:summary:${block.id}`);
    if (heading) { if (!disabled && heading.collapsed) useStore.getState().updateBlock(pageId, heading.id, { collapsed: false }); document.querySelector(`[data-block-id="${CSS.escape(heading.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }
  };
  if (disabled) return <div className="rounded border border-border p-3 text-sm">{!topLevel ? "Move this meeting to the page to record." : `Meeting: ${block.meeting?.status ?? "idle"} · ${clock(block.meeting?.durationMs ?? 0)}`}</div>;
  return <div className="space-y-2 rounded border border-border p-3 text-sm">
    <p className="text-xs text-text-secondary">Tell the participants you are recording. Audio is transcribed by Meta and never stored.</p>
    {view.recovered > 0 && <p role="status">Recording was interrupted. {view.recovered} minutes recovered.</p>}
    {view.status === "idle" && <button type="button" aria-label="Start recording" disabled={view.busy} className="rounded border border-border px-3 py-1 text-sm hover:bg-bg-secondary disabled:opacity-50" onClick={() => void controller.current?.start()}>{view.busy ? "Preparing microphone..." : "Start recording"}</button>}
    {view.status === "recording" && <><div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-red-600" /><span>Recording {clock(view.duration)}</span><meter aria-label="Microphone level" min={0} max={1} value={Math.min(1, view.level)} /><button type="button" aria-label="Stop" disabled={view.busy} className="rounded border border-border px-3 py-1 text-sm hover:bg-bg-secondary disabled:opacity-50" onClick={() => void controller.current?.stop()}>Stop</button></div>{view.minute > 0 && view.pending > 0 && <p>Transcribing minute {view.minute}...</p>}{view.duration >= 3300000 && <p role="status">This meeting will stop at 60 minutes. Your transcript will be saved.</p>}</>}
    {view.status === "transcribing" && <p role="status">Transcribing {view.pending} remaining segments...</p>}
    {view.status === "summarizing" && <p role="status">Trama is summarizing...</p>}
    {view.status === "ready" && <p>Meeting ready · {clock(view.duration)} {view.duration >= 60000 ? <button type="button" aria-label="Summary" className="underline" onClick={summary}>Summary</button> : "Record at least one minute for an automatic summary."}</p>}
    {view.status === "failed" && <div role="alert"><p>{view.error || "This meeting was interrupted. Retry to continue."}</p><button type="button" aria-label="Retry" disabled={view.busy} className="rounded border border-border px-3 py-1 text-sm hover:bg-bg-secondary disabled:opacity-50" onClick={() => void controller.current?.recover(true)}>Retry</button></div>}
  </div>;
}
