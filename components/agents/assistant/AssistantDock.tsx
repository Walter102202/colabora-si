"use client";

import { Bot } from "lucide-react";
import { type ClipboardEvent, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { AssistantThreadView } from "@/components/agents/assistant/AssistantThreadView";
import { VoiceButton } from "@/components/agents/assistant/VoiceButton";
import { getAgentClient } from "@/lib/agentClient";
import { type Draft, useAgentConversation } from "@/lib/agentConversation";
import { MAX_RECORDING_MS, type Recorder, startRecorder, uploadWav, voiceFailure, voiceReducer } from "@/lib/agentVoice";
import { pageUrl } from "@/lib/routes";

const voiceUrl = () => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/voice-transcribe`;

// Connector of the conversation: the smallest always-on surface, in the topbar. P12 replaces this file and keeps the views.
// `workspaceId` and `userId` come from InboxBell, which already knows the signed-in person.
export function AssistantDock({ workspaceId, userId }: { workspaceId: string; userId: string }) {
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const pageId = /^\/p\/([^/]+)/.exec(pathname)?.[1];
  const subscribe = useAgentConversation((s) => s.subscribe);
  const messages = useAgentConversation((s) => s.messages);
  const failed = useAgentConversation((s) => s.failed);
  const send = useAgentConversation((s) => s.send);
  const undo = useAgentConversation((s) => s.undo);
  const openNotes = useAgentConversation((s) => s.openNotes);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [voice, dispatch] = useReducer(voiceReducer, { phase: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<Recorder | null>(null);
  const wav = useRef<ArrayBuffer | null>(null);
  const clip = useRef<string | null>(null);
  const pasted = useRef(false);
  const selection = useRef<string>("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => subscribe(workspaceId, userId), [workspaceId, userId, subscribe]);

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
    const session = (await getAgentClient()?.auth.getSession())?.data.session;
    if (!session || !wav.current) return dispatch({ type: "fail", reason: "network", canRetry: false });
    try {
      const out = await uploadWav({
        url: `${voiceUrl()}?workspace_id=${encodeURIComponent(workspaceId)}&lang=${navigator.language.startsWith("en") ? "en" : "es"}`,
        token: session.access_token, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, wav: wav.current,
        onSent: () => dispatch({ type: "sent" }),
      });
      wav.current = null;
      if (!out.transcript) return dispatch({ type: "fail", reason: "no_speech", canRetry: false });
      clip.current = out.clip_id;
      setDraft(out.transcript);
      pasted.current = false;
      dispatch({ type: "heard", clipId: out.clip_id, transcript: out.transcript });
    } catch (error) {
      dispatch({ type: "fail", ...voiceFailure(error instanceof Error ? error.message : "voice_failed") });
    }
  }, [workspaceId]);

  async function finish() {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    dispatch({ type: "stop" });
    wav.current = await active.stop();
    await upload();
  }

  async function press() {
    dispatch({ type: "press" });
    setElapsed(0);
    try {
      recorder.current = await startRecorder();
      dispatch({ type: "granted", at: Date.now() });
    } catch (error) {
      dispatch({ type: "fail", ...voiceFailure(error instanceof Error ? error.message : "unsupported") });
    }
  }

  function cancel() {
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
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button type="button" className="icon-button" aria-label="Agent" aria-expanded={open} onClick={toggle}><Bot size={17} /></button>
      {open && (
        <div className="menu-panel absolute right-0 top-full z-30 mt-1 w-96 max-w-[90vw] p-2">
          <AssistantThreadView
            messages={messages}
            draft={draft}
            reviewing={voice.phase === "review"}
            error={failed?.error ?? null}
            onRetrySend={failed ? () => void submit(failed) : null}
            onDraft={(text) => { setDraft(text); if (!text) { pasted.current = false; clip.current = null; if (voice.phase === "review") dispatch({ type: "reset" }); } }}
            onPaste={onPaste}
            onSend={() => void submit()}
            onUndo={(id) => void undo(id)}
            onOpenNotes={() => { void openNotes().then((id) => { if (id) { setOpen(false); void navigate(pageUrl(id)); } }); }}
            voice={<VoiceButton state={voice} elapsedMs={elapsed} onPress={() => void press()} onStop={() => void finish()} onCancel={cancel} onRetry={retry} />}
          />
        </div>
      )}
    </div>
  );
}
