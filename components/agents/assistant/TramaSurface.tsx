"use client";

import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { TramaAvatar } from "@/components/agents/TramaAvatar";
import { isTrama } from "@/lib/tramaIdentity";
import { tramaSuggestions } from "@/lib/tramaSuggestions";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";
import { useAgentTasks, waitingOnYou } from "@/lib/agentTasks";
import { createTask } from "@/lib/agentActions";
import { type ClipboardEvent, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { AssistantThreadView } from "@/components/agents/assistant/AssistantThreadView";
import { VoiceButton } from "@/components/agents/assistant/VoiceButton";
import { getAgentClient } from "@/lib/agentClient";
import { type Draft, type PersonMessage, useAgentConversation } from "@/lib/agentConversation";
import { MAX_RECORDING_MS, type Recorder, startRecorder, uploadWav, voiceFailure, voiceReducer } from "@/lib/agentVoice";
import { HOME_URL, settingsUrl, taskUrl, pageUrl } from "@/lib/routes";

const voiceUrl = () => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/voice-transcribe`;

// Persistent workspace surface. The character stays untouched; state is displayed beside it.
// `workspaceId` and `userId` come from InboxBell, which already knows the signed-in person.
export function TramaSurface({ workspaceId, userId }: { workspaceId: string; userId: string }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const pageId = /^\/p\/([^/]+)/.exec(pathname)?.[1];
  const subscribe = useAgentConversation((s) => s.subscribe);
  const messages = useAgentConversation((s) => s.messages);
  const failed = useAgentConversation((s) => s.failed);
  const send = useAgentConversation((s) => s.send);
  const undo = useAgentConversation((s) => s.undo);
  const openNotes = useAgentConversation((s) => s.openNotes);
  const agents = useAgentsStore((s) => s.agents);
  const agentStatus = useAgentsStore((s) => s.status);
  const agentWorkspace = useAgentsStore((s) => s.workspaceId);
  const loadAgents = useAgentsStore((s) => s.load);
  const tasks = useAgentTasks((s) => s.tasks);
  const currentPage = useStore((s) => pageId ? s.pages[pageId] : undefined);
  const trama = agentWorkspace === workspaceId ? agents.find((a) => isTrama(a) && !a.revoked_at) : undefined;
  const waiting = waitingOnYou({ tasks } as Parameters<typeof waitingOnYou>[0]).filter((t) => t.workspace_id === workspaceId && t.owner_user_id === userId).length;
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem("trama-folded") === "1"; } catch { return false; } });
  const [selected, setSelected] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [proposing, setProposing] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const proposalLock = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const suggestions = tramaSuggestions({ kind: new URLSearchParams(search).has("task") ? "task" : currentPage?.database ? "database" : pageId ? "text" : "home", selection: selected, decisions: waiting, lang: navigator.language.startsWith("es") ? "es" : "en" });
  const pending = messages.findLast((m) => m.direction === "in" && m.needs_reply);
  const missing = agentWorkspace === workspaceId && agentStatus === "ready" && !trama;
  const status = pending ? now - Date.parse(pending.created_at) >= 60_000 ? "Trama is not answering right now. Your message stays here." : "Trama is thinking…" : null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [voice, dispatch] = useReducer(voiceReducer, { phase: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<Recorder | null>(null);
  const captureBusy = useRef(false);
  const captureVersion = useRef(0);
  const voiceBusy = ["asking", "recording", "sending", "transcribing"].includes(voice.phase);
  const wav = useRef<ArrayBuffer | null>(null);
  const clip = useRef<string | null>(null);
  const pasted = useRef(false);
  const selection = useRef<string>("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => subscribe(workspaceId, userId), [workspaceId, userId, subscribe]);
  useEffect(() => { void loadAgents(workspaceId); }, [workspaceId, userId, loadAgents]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  useEffect(() => {
    const changed = () => { if (!ref.current?.contains(document.activeElement)) setSelected(Boolean(window.getSelection()?.toString().trim())); };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, []);
  useEffect(() => () => { captureVersion.current += 1; recorder.current?.cancel(); recorder.current = null; captureBusy.current = false; }, []);
  const close = useCallback(() => {
    if (captureBusy.current) {
      captureVersion.current += 1; recorder.current?.cancel(); recorder.current = null;
      captureBusy.current = false; wav.current = null; dispatch({ type: "reset" });
    }
    setOpen(false); trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector("textarea")?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, close]);
  const fold = () => { setFolded(true); try { localStorage.setItem("trama-folded", "1"); } catch { /* optional preference */ } };
  async function propose(message: PersonMessage) {
    const original = messages.find((m) => m.id === message.outcome?.message_id && m.direction === "in");
    if (!trama || !original || !message.outcome?.page_id || proposalLock.current) return;
    proposalLock.current = true; setProposing(message.id); setProposalError(null);
    try {
      const result = await createTask(message.outcome.page_id, { objective: original.body }, trama.id, { idempotencyKey: "proposal:" + original.id });
      close(); void navigate(taskUrl(message.outcome.page_id, result.task_id));
    } catch (e) { setProposalError(e instanceof Error ? e.message : "Could not start the task."); }
    finally { proposalLock.current = false; setProposing(null); }
  }
  const suggest = (body: string) => {
    selection.current = window.getSelection()?.toString().trim() || selection.current;
    setOpen(true);
    void submit({ clientId: crypto.randomUUID(), body, context: { ...(pageId ? { page_id: pageId } : {}), ...(pageId && selection.current ? { selection: { page_id: pageId, text: selection.current } } : {}) } });
  };

  // The selection is read when the panel opens: a click inside the panel clears it.
  const toggle = () => {
    if (!open) selection.current = window.getSelection()?.toString().trim() ?? "";
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (voice.phase !== "recording") return;
    const timer = setInterval(() => {
      const ms = Date.now() - voice.startedAt;
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS) void finish();
    }, 250);
    return () => clearInterval(timer);
  });

  const upload = useCallback(async () => {
    const version = captureVersion.current;
    captureBusy.current = true;
    try {
      const session = (await getAgentClient()?.auth.getSession())?.data.session;
      if (version !== captureVersion.current) return;
      if (!session || !wav.current) return dispatch({ type: "fail", reason: "network", canRetry: false });
      const out = await uploadWav({
        url: `${voiceUrl()}?workspace_id=${encodeURIComponent(workspaceId)}&lang=${navigator.language.startsWith("en") ? "en" : "es"}`,
        token: session.access_token, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, wav: wav.current,
        onSent: () => { if (version === captureVersion.current) dispatch({ type: "sent" }); },
      });
      if (version !== captureVersion.current) return;
      wav.current = null;
      if (!out.transcript) return dispatch({ type: "fail", reason: "no_speech", canRetry: false });
      clip.current = out.clip_id;
      setDraft(out.transcript); pasted.current = false;
      dispatch({ type: "heard", clipId: out.clip_id, transcript: out.transcript });
    } catch (error) {
      if (version === captureVersion.current) dispatch({ type: "fail", ...voiceFailure(error instanceof Error ? error.message : "voice_failed") });
    } finally { if (version === captureVersion.current) captureBusy.current = false; }
  }, [workspaceId]);

  async function finish() {
    const active = recorder.current;
    if (!active) return;
    const version = captureVersion.current;
    recorder.current = null; dispatch({ type: "stop" });
    try {
      const audio = await active.stop();
      if (version !== captureVersion.current) return;
      wav.current = audio;
      await upload();
    } catch {
      active.cancel();
      if (version === captureVersion.current) { captureBusy.current = false; dispatch({ type: "fail", reason: "voice_failed", canRetry: false }); }
    }
  }

  async function press() {
    if (captureBusy.current) return;
    captureBusy.current = true;
    const version = ++captureVersion.current;
    dispatch({ type: "press" }); setElapsed(0);
    try {
      const active = await startRecorder();
      if (version !== captureVersion.current) { active.cancel(); return; }
      recorder.current = active;
      dispatch({ type: "granted", at: Date.now() });
    } catch (error) {
      if (version === captureVersion.current) {
        captureBusy.current = false;
        dispatch({ type: "fail", ...voiceFailure(error instanceof Error ? error.message : "unsupported") });
      }
    }
  }

  function cancel() {
    captureVersion.current += 1; captureBusy.current = false;
    recorder.current?.cancel();
    recorder.current = null;
    wav.current = null;
    dispatch({ type: "reset" });
  }

  function retry() {
    dispatch({ type: "retry" });
    void upload();
  }

  // Only a paste at the start of an empty box makes the message someone else's text. "guarda en notas: " plus a paste remains a person request; Trama must still call the server-verified skill.
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (e.currentTarget.selectionStart === 0 && !draft) pasted.current = true;
  }

  async function submit(from?: Draft) {
    if (captureBusy.current) return;
    const body = (from?.body ?? draft).trim();
    if (!body) return;
    const out: Draft = from ?? {
      clientId: crypto.randomUUID(), body,
      context: {
        pasted: pasted.current, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(pageId ? { page_id: pageId } : {}), ...(pageId && selection.current ? { selection: { page_id: pageId, text: selection.current } } : {}),
      },
      ...(clip.current ? { clipId: clip.current } : {}),
    };
    setDraft("");
    pasted.current = false;
    selection.current = "";
    clip.current = null;
    dispatch({ type: "reset" });
    await send(out);
  }

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, close]);

  return createPortal(
    <div ref={ref} className="fixed bottom-4 right-4 z-30 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2" data-trama-surface>
      {open && <section role="dialog" aria-label="Trama conversation" className="rounded-md border border-border bg-bg shadow-lg w-96 max-w-[calc(100vw-1.5rem)] max-h-[70vh] overflow-auto p-3">
        <div className="flex justify-end"><button type="button" aria-label="Close Trama" className="icon-button" onClick={close}><X size={16} /></button></div>
        <AssistantThreadView messages={messages} draft={draft} busy={voiceBusy} reviewing={voice.phase === "review"}
          error={proposalError ?? failed?.error ?? null} avatar={<TramaAvatar size={28} decorative />}
          empty={<span className="flex flex-col items-center gap-3 py-5"><TramaAvatar size={96} decorative /><span>Connects, coordinates, stays with you.</span></span>}
          onRetrySend={failed ? () => void submit(failed) : null}
          onDraft={(text) => { setDraft(text); if (!text) { pasted.current = false; clip.current = null; if (voice.phase === "review") dispatch({ type: "reset" }); } }}
          onPaste={onPaste} onSend={() => void submit()} onUndo={(id) => void undo(id)}
          onPropose={(message) => void propose(message)} proposing={proposing}
          onOpenNotes={() => { void openNotes().then((id) => { if (id) { close(); void navigate(pageUrl(id)); } }); }}
          voice={<VoiceButton state={voice} elapsedMs={elapsed} onPress={() => void press()} onStop={() => void finish()} onCancel={cancel} onRetry={retry} />}
        />
        <div className="mt-2 flex flex-wrap gap-1">{suggestions.map((text) => <button type="button" key={text} disabled={voiceBusy} onClick={() => suggest(text)} className="rounded border border-border px-2 py-1 text-left text-xs hover:bg-bg-secondary">{text}</button>)}</div>
      </section>}
      {status && <p role="status" className="max-w-72 rounded border border-border bg-bg px-3 py-2 text-xs text-text-secondary">{status}</p>}
      {waiting > 0 && <a href={HOME_URL} className="rounded bg-bg px-2 py-1 text-xs text-accent">{waiting} decisions wait for you</a>}
      <div className="flex items-center gap-2">
        {!folded && <div className="flex max-w-64 items-center gap-1 rounded-full border border-border bg-bg px-3 py-2 text-sm shadow-sm">
          {missing ? <a href={settingsUrl("agents", pathname)} className="text-accent">Enable Trama</a> : <button type="button" className="text-left" onClick={() => suggest(suggestions[0])}>{suggestions[0]}</button>}
          <button type="button" aria-label="Hide suggestion" className="icon-button shrink-0" onClick={fold}><X size={14} /></button>
        </div>}
        <button ref={trigger} type="button" aria-label="Talk to Trama" aria-expanded={open} className="shrink-0 focus-visible:outline-2 focus-visible:outline-accent" onClick={toggle}><TramaAvatar size={40} /></button>
      </div>
    </div>, document.body,
  );
}
