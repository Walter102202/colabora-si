"use client";

import { Sparkles, X } from "lucide-react";
import { createPortal } from "react-dom";
import { TramaAvatar } from "@/components/agents/TramaAvatar";
import { isTrama } from "@/lib/tramaIdentity";
import { TRAMA_GREETING, tramaSuggestions } from "@/lib/tramaSuggestions";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";
import { buildDecisionsHome } from "@/lib/agentHome";
import { useAgentTasks, type ApprovalRow } from "@/lib/agentTasks";
import { decideApproval, type ApprovalDecision } from "@/lib/agentActions";
import { ApprovalCard } from "@/components/agents/panel/ApprovalCard";
import { proposedLessons, useAgentLessons } from "@/lib/agentLessons";
import { openDiscrepancies, useAgentSources } from "@/lib/agentSources";
import { useAuthStore } from "@/lib/auth";
import { type ClipboardEvent, type FocusEvent, type PointerEvent, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { AssistantThreadView } from "@/components/agents/assistant/AssistantThreadView";
import { VoiceButton } from "@/components/agents/assistant/VoiceButton";
import { getAgentClient } from "@/lib/agentClient";
import { currentThread, declineProposedWork, startProposedWork, sendProposedMessage, refreshAgentConversation, settleAgentProposal, type Draft, type PersonMessage, useAgentConversation } from "@/lib/agentConversation";
import { agentInputFor } from "@/lib/agentDefaults";
import { foreignPageIds } from "@/lib/foreignPages";
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
  const thread = useMemo(() => currentThread(messages), [messages]);
  const newConversation = useAgentConversation((s) => s.newConversation);
  const failed = useAgentConversation((s) => s.failed);
  const send = useAgentConversation((s) => s.send);
  const undo = useAgentConversation((s) => s.undo);
  const openNotes = useAgentConversation((s) => s.openNotes);
  const agents = useAgentsStore((s) => s.agents);
  const agentStatus = useAgentsStore((s) => s.status);
  const agentWorkspace = useAgentsStore((s) => s.workspaceId);
  const loadAgents = useAgentsStore((s) => s.load);
  const tasks = useAgentTasks((s) => s.tasks);
  const approvals = useAgentTasks((s) => s.approvals);
  const runs = useAgentTasks((s) => s.runs);
  const subscribeTasks = useAgentTasks((s) => s.subscribe);
  const user = useAuthStore((s) => s.user);
  const lessons = useAgentLessons((s) => s.lessons);
  const discrepancies = useAgentSources((s) => s.discrepancies);
  const subscribeLessons = useAgentLessons((s) => s.subscribe);
  const subscribeSources = useAgentSources((s) => s.subscribe);
  const lessonCount = useMemo(() => proposedLessons(lessons).filter((l) => l.workspace_id === workspaceId).length, [lessons, workspaceId]);
  const differenceCount = useMemo(() => openDiscrepancies(discrepancies).filter((d) => d.workspace_id === workspaceId).length, [discrepancies, workspaceId]);
  const currentPage = useStore((s) => pageId ? s.pages[pageId] : undefined);
  const taskDatabase = useStore((s) => s.syncWorkspaceId === workspaceId ? Object.values(s.pages).filter((page) => !page.isDeleted && !foreignPageIds.has(page.id)).sort((a, b) => a.createdAt - b.createdAt).find((page) => page.database?.properties.some((property) => property.type === "agentStatus")) : undefined);
  const trama = agentWorkspace === workspaceId ? agents.find((a) => isTrama(a) && !a.revoked_at) : undefined;
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem("trama-folded") === "1"; } catch { return false; } });
  const [selected, setSelected] = useState(false);
  const [now, setNow] = useState(Date.now);
  const home = useMemo(() => buildDecisionsHome({ tasks: Object.values(tasks).filter((t) => t.workspace_id === workspaceId), approvals: Object.values(approvals), runs, agents, userId, now }), [tasks, workspaceId, approvals, runs, agents, userId, now]);
  const pendingDecisions = useMemo(() => {
    const waitingIds = new Set(home.waiting.map((item) => item.key));
    return Object.values(approvals).filter((approval) => approval.kind === "action" && waitingIds.has(`approval:${approval.id}`));
  }, [approvals, home.waiting]);
  const [decisionReceipts, setDecisionReceipts] = useState<Record<string, { approval: ApprovalRow; approved: boolean; snapshot: typeof approvals; workspaceId: string; userId: string }>>({});
  const decisionLocks = useRef(new Map<string, Promise<void>>());
  const currentReceipts = Object.values(decisionReceipts).filter((receipt) => receipt.snapshot === approvals && receipt.workspaceId === workspaceId && receipt.userId === userId);
  const decisions = [...pendingDecisions, ...currentReceipts.filter((receipt) => !pendingDecisions.some((approval) => approval.id === receipt.approval.id)).map((receipt) => receipt.approval)];
  const waiting = home.waiting.length;
  const [revealed, setRevealed] = useState(false);
  const descriptionId = useId();
  const body = useRef<HTMLSpanElement>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastJump = useRef(-Infinity);
  const suppressFocus = useRef(false);
  const [proposing, setProposing] = useState<{ id: string; action: "start" | "decline" | "agent" | "message" } | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const resetLock = useRef(false);
  const proposalLock = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const suggestions = tramaSuggestions({ kind: new URLSearchParams(search).has("task") ? "task" : currentPage?.database ? "database" : pageId ? "text" : "home", selection: selected, decisions: waiting });
  const pending = messages.findLast((m) => m.direction === "in" && m.needs_reply);
  const missing = agentWorkspace === workspaceId && agentStatus === "ready" && !trama;
  const managed = import.meta.env.VITE_TRAMA_MANAGED === "1";
  // A new workspace gets its Trama from the managed runtime within seconds.
  useEffect(() => {
    if (!missing || !managed || !workspaceId) return;
    const timer = setInterval(() => void loadAgents(workspaceId), 5000);
    return () => clearInterval(timer);
  }, [missing, managed, workspaceId, loadAgents]);
  const status = pending ? now - Date.parse(pending.created_at) >= 60_000 ? "Trama is not answering right now. Your message stays here." : "Trama is thinking…" : null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [scrollRequest, setScrollRequest] = useState(0);
  const expanded = revealed && !open;
  const countText = waiting === 1 ? "1 decision waits for you" : `${waiting} decisions wait for you`;
  const reviewText = [lessonCount ? `${lessonCount} lesson${lessonCount === 1 ? "" : "s"}` : "", differenceCount ? `${differenceCount} difference${differenceCount === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  const reviewNotice = reviewText ? `${reviewText} to ${lessonCount ? "review" : "settle"}` : "";
  const preview = waiting ? home.waiting[0] : home.working[0];
  const previewText = preview ? `${waiting ? "First" : "In progress"}: ${preview.title}` : "";
  const hidePreview = useCallback(() => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    revealTimer.current = null; hideTimer.current = null; setRevealed(false);
  }, []);
  useEffect(() => () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);
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
  const leaveFocus = (event: FocusEvent<HTMLElement>) => {
    if (!ref.current?.contains(event.relatedTarget as Node | null)) hidePreview();
  };

  useEffect(() => subscribe(workspaceId, userId), [workspaceId, userId, subscribe]);
  useEffect(() => {
    const releaseLessons = subscribeLessons(workspaceId);
    const releaseSources = subscribeSources(workspaceId);
    return () => { releaseLessons(); releaseSources(); };
  }, [workspaceId, user, subscribeLessons, subscribeSources]);
  useEffect(() => {
    if (!getAgentClient() || !workspaceId || !userId) return;
    void loadAgents(workspaceId);
    return subscribeTasks(workspaceId);
  }, [workspaceId, userId, loadAgents, subscribeTasks]);
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
    hidePreview(); setOpen(false);
    suppressFocus.current = true; trigger.current?.focus(); suppressFocus.current = false;
  }, [hidePreview]);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector("textarea")?.focus();
  }, [open]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (open || revealed || revealTimer.current)) { event.preventDefault(); if (open) close(); else hidePreview(); }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, revealed, close, hidePreview]);
  const fold = () => { setFolded(true); try { localStorage.setItem("trama-folded", "1"); } catch { /* optional preference */ } };
  async function resetConversation() {
    if (resetLock.current) return;
    resetLock.current = true; setResetting(true);
    try {
      if (await newConversation()) {
        setResetError(null); setProposalError(null);
        ref.current?.querySelector("textarea")?.focus();
      } else setResetError("Could not start a new conversation.");
    } finally { resetLock.current = false; setResetting(false); }
  }
  function decideInChat(approval: ApprovalRow, decision: ApprovalDecision, response: Record<string, unknown> | null): Promise<void> {
    const pending = decisionLocks.current.get(approval.id);
    if (pending) return pending;
    const request = (async () => {
      try {
        await decideApproval(approval.id, decision, response);
        const snapshot = useAgentTasks.getState().approvals;
        setDecisionReceipts((current) => ({
          ...Object.fromEntries(Object.entries(current).filter(([, receipt]) => receipt.snapshot === snapshot)),
          [approval.id]: { approval, approved: decision === "approve" || decision === "edit", snapshot, workspaceId, userId },
        }));
      } finally { decisionLocks.current.delete(approval.id); }
    })();
    decisionLocks.current.set(approval.id, request);
    return request;
  }
  async function propose(message: PersonMessage) {
    if (proposalLock.current) return;
    proposalLock.current = true; setProposing({ id: message.id, action: "start" }); setProposalError(null);
    try {
      const result = await startProposedWork(message.id);
      close(); void navigate(taskUrl(result.page_id, result.task_id));
    } catch (e) { setProposalError(e instanceof Error ? e.message : "Could not start the task."); }
    finally { proposalLock.current = false; setProposing(null); }
  }
  async function sendMessageProposal(message: PersonMessage, addRequirement = false) {
    if (proposalLock.current) return;
    proposalLock.current = true; setProposing({ id: message.id, action: "message" }); setProposalError(null);
    try { await sendProposedMessage(message.id, addRequirement); }
    catch (e) { setProposalError(e instanceof Error ? e.message : "Could not send the message."); }
    finally {
      await refreshAgentConversation(workspaceId).catch(() => {});
      proposalLock.current = false; setProposing(null);
    }
  }
  async function declineWork(message: PersonMessage) {
    if (proposalLock.current) return;
    proposalLock.current = true; setProposing({ id: message.id, action: "decline" }); setProposalError(null);
    try { await declineProposedWork(message.id); }
    catch (e) { setProposalError(e instanceof Error ? e.message : "Could not decline the task."); }
    finally {
      await refreshAgentConversation(workspaceId).catch(() => {});
      proposalLock.current = false; setProposing(null);
    }
  }
  const suggest = (body: string) => {
    selection.current = window.getSelection()?.toString().trim() || selection.current;
    setOpen(true);
    void submit({ clientId: crypto.randomUUID(), body, context: { ...(pageId ? { page_id: pageId } : {}), ...(pageId && selection.current ? { selection: { page_id: pageId, text: selection.current } } : {}) } });
  };

  async function settleAgent(message: PersonMessage, accept: boolean) {
    if (proposalLock.current) return;
    proposalLock.current = true; setProposing({ id: message.id, action: "agent" }); setProposalError(null);
    try {
      const proposal = await settleAgentProposal(message.id, accept);
      if (accept) {
        await loadAgents(workspaceId);
        const state = useAgentsStore.getState();
        if (state.workspaceId !== workspaceId || state.status !== "ready") throw new Error("Workspace unavailable");
        await state.createAgent(agentInputFor(proposal.name, proposal.harness, proposal.role,
          taskDatabase ? [{ pageId: taskDatabase.id, scopes: ["read", "write", "comment"], inherit: true }] : []), { issueToken: false });
      }
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("already_settled"))) setProposalError("We couldn’t create this agent. You can add it in Settings → Agents.");
    } finally {
      await refreshAgentConversation(workspaceId).catch(() => {});
      proposalLock.current = false; setProposing(null);
    }
  }

  // Capture the selection before moving focus into the conversation.
  const openConversation = () => {
    if (!open) selection.current = window.getSelection()?.toString().trim() ?? "";
    hidePreview(); setOpen(true);
  };
  const toggle = () => { if (open) close(); else openConversation(); };
  const enterTrama = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "mouse" || open) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => { revealTimer.current = null; setRevealed(true); }, 350);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && Date.now() - lastJump.current >= 3000) {
      lastJump.current = Date.now();
      body.current?.animate?.([
        { offset: 0, transform: "none", easing: "cubic-bezier(.33,0,.67,1)" },
        { offset: .2, transform: "scale(1.04,.94)", easing: "cubic-bezier(.2,.7,.4,1)" },
        { offset: .5, transform: "translateY(-2px) scale(.98,1.04)", easing: "cubic-bezier(.6,0,.8,.4)" },
        { offset: .74, transform: "scale(1.02,.98)", easing: "cubic-bezier(.2,.7,.4,1)" },
        { offset: 1, transform: "none" },
      ], { duration: 360 });
    }
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
    setScrollRequest((value) => value + 1);
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
    <div ref={ref} role="group" aria-label="Trama assistant"
      onPointerEnter={(event) => { if (event.pointerType === "mouse" && hideTimer.current) clearTimeout(hideTimer.current); }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        if (revealTimer.current) clearTimeout(revealTimer.current);
        revealTimer.current = null;
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(hidePreview, 500);
      }}
      className="fixed bottom-4 right-4 z-30 flex max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] flex-col items-end gap-2" data-trama-surface>
      {open && <section role="dialog" aria-label="Trama conversation" className="flex h-[34rem] min-h-0 max-h-[calc(100dvh-5.5rem)] w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-bg p-3 shadow-lg">
        <div className="flex shrink-0 justify-end"><button type="button" aria-label="Close Trama" className="icon-button" onClick={close}><X size={16} /></button></div>
        <AssistantThreadView key={workspaceId} messages={thread} draft={draft} scrollRequest={scrollRequest} status={status} busy={voiceBusy} reviewing={voice.phase === "review"}
          onNewConversation={() => { void resetConversation(); }} resetting={resetting}
          decisions={decisions.length > 0 ? <section aria-label="Needs your decision" className="max-h-60 shrink-0 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
            <h3 className="text-sm font-medium">Needs your decision</h3>
            {decisions.map((approval) => {
              const receipt = currentReceipts.find((item) => item.approval.id === approval.id);
              return receipt ? <p key={approval.id} role="status" className="text-sm">{receipt.approved ? "Approved." : "Denied."}</p>
                : <ApprovalCard key={approval.id} approval={approval} onDecide={(decision, response) => decideInChat(approval, decision, response)} />;
            })}
          </section> : null}
          error={proposalError ?? resetError ?? failed?.error ?? null} avatar={<TramaAvatar size={28} decorative />}
          empty={<span className="flex flex-col items-center gap-3 py-5">
            <TramaAvatar size={96} decorative />
            <span className="flex flex-col items-center gap-2">
              <span>Connects, coordinates, stays with you.</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/15 bg-accent/5 px-2.5 py-1 text-[11px] leading-4 text-text-secondary">
                <Sparkles size={12} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
                <span>Powered by <span className="font-semibold text-text">Muse</span></span>
              </span>
            </span>
          </span>}
          onRetrySend={failed ? () => void submit(failed) : null}
          onDraft={(text) => { setDraft(text); if (!text) { pasted.current = false; clip.current = null; if (voice.phase === "review") dispatch({ type: "reset" }); } }}
          onPaste={onPaste} onSend={() => void submit()} onUndo={(id) => void undo(id)}
          onPropose={(message) => void propose(message)} onDeclineWork={(message) => void declineWork(message)} onSendMessage={(message, addRequirement) => void sendMessageProposal(message, addRequirement)} proposing={proposing}
          onSettleAgent={(message, accept) => void settleAgent(message, accept)} hasTaskDatabase={Boolean(taskDatabase)} agentProposalError={proposalError?.startsWith("We couldn’t create this agent.")}
          onOpenNotes={() => { void openNotes().then((id) => { if (id) { close(); void navigate(pageUrl(id)); } }); }}
          voice={<VoiceButton state={voice} elapsedMs={elapsed} onPress={() => void press()} onStop={() => void finish()} onCancel={cancel} onRetry={retry} />}
        />
        <div className="mt-2 flex shrink-0 flex-wrap gap-1 [@media(max-height:500px)]:hidden">{suggestions.map((text) => <button type="button" key={text} disabled={voiceBusy} onClick={() => suggest(text)} className="rounded border border-border px-2 py-1 text-left text-xs hover:bg-bg-secondary">{text}</button>)}</div>
      </section>}
      {status && !open && <p role="status" className="max-w-72 shrink-0 rounded border border-border bg-bg px-3 py-2 text-xs text-text-secondary">{status}</p>}
      {(waiting > 0 || reviewNotice || (expanded && preview)) && <div className="relative max-w-72 shrink-0 rounded-xl border border-border bg-bg px-2.5 py-1.5 text-xs">
        {waiting > 0 && <a href={HOME_URL} onBlur={leaveFocus} className="block text-accent">{countText}</a>}
        {reviewNotice && <a href={HOME_URL} onBlur={leaveFocus} className="block text-accent">{reviewNotice}</a>}
        {expanded && preview && <a href={preview.href} onBlur={leaveFocus} className="block truncate text-text-secondary">{previewText}</a>}
        <span aria-hidden="true" className="absolute -bottom-1 right-3 h-2 w-2 rotate-45 border-b border-r border-border bg-bg" />
      </div>}
      <span id={descriptionId} className="sr-only">{[waiting > 0 ? countText : "", reviewNotice, expanded ? previewText : ""].filter(Boolean).join(". ")}</span>
      <div className="flex shrink-0 items-center gap-2">
        {!folded && <div className="flex max-w-64 items-center gap-1 rounded-full border border-border bg-bg px-3 py-2 text-sm shadow-sm">
          {missing && managed ? <span>Trama is getting ready…</span> : missing ? <a href={settingsUrl("agents", pathname)} className="text-accent">Enable Trama</a> : <button type="button" className="text-left" onClick={openConversation}>{TRAMA_GREETING}</button>}
          <button type="button" aria-label="Hide suggestion" className="icon-button shrink-0" onClick={fold}><X size={14} /></button>
        </div>}
        <button ref={trigger} type="button" aria-label="Talk to Trama" aria-expanded={open} aria-describedby={descriptionId} onBlur={leaveFocus}
          style={{ background: "transparent" }} className="shrink-0 focus-visible:outline-2 focus-visible:outline-accent" onClick={toggle}
          onPointerEnter={enterTrama}
          onPointerLeave={() => { if (revealTimer.current) clearTimeout(revealTimer.current); revealTimer.current = null; }}
          onPointerDown={() => { suppressFocus.current = true; }} onPointerUp={() => { suppressFocus.current = false; }} onPointerCancel={() => { suppressFocus.current = false; }}
          onFocus={(event) => { if (!open && !suppressFocus.current && event.currentTarget.matches(":focus-visible")) setRevealed(true); }}>
          <span ref={body} className="block origin-[49%_96%]"><TramaAvatar size={40} /></span>
        </button>
      </div>
    </div>, document.body,
  );
}
