"use client";

import { ArrowDown, Send, Sparkles } from "lucide-react";
import type { ClipboardEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { TramaAvatar } from "@/components/agents/TramaAvatar";
import { useConversationScroll } from "@/components/agents/assistant/useConversationScroll";
import type { PersonMessage } from "@/lib/agentConversation";
import { VOICE_NOTICE } from "@/lib/agentVoice";
import { CONNECT_AGENT_NAMES } from "@/lib/agentConnectCatalog";
import { connectUrl, settingsUrl, taskUrl } from "@/lib/routes";
import { safeHref } from "@/lib/utils";

function appLinks(body: string): ReactNode {
  if (typeof window === "undefined") return body;
  return body.split(/(https?:\/\/[^\s<>"']+)/gi).map((part, index) => {
    if (index % 2 === 0) return part;
    const url = part.replace(/[.,;:!?)\]]+$/, "");
    const href = safeHref(url);
    try {
      if (href && new URL(href).origin === window.location.origin) {
        return <span key={index}><a href={href} className="text-accent underline">{url}</a>{part.slice(url.length)}</span>;
      }
    } catch { /* Keep malformed URLs as text. */ }
    return part;
  });
}

function SentMessage({ outcome }: { outcome: NonNullable<PersonMessage["outcome"]> }) {
  const [now, setNow] = useState(Date.now);
  const due = outcome.sent_at ? Date.parse(outcome.sent_at) + 5 * 60_000 : NaN;
  const received = outcome.received_at ? new Date(outcome.received_at) : null;
  const waiting = !received && (outcome.delivery === "queued_for_next_session" || now >= due);
  useEffect(() => {
    if (outcome.received_at || outcome.delivery === "queued_for_next_session" || !Number.isFinite(due) || now >= due) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [outcome.received_at, outcome.delivery, due, now]);
  return <div className="mt-2 space-y-1">
    <p>{received ? `${outcome.agent_name || "The agent"} got it at ${received.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}.` : `Sent${outcome.agent_name ? ` to ${outcome.agent_name}` : ""}.`}</p>
    {outcome.task_title && <p>On {outcome.task_title}</p>}
    {outcome.text && <p className="whitespace-pre-wrap">{outcome.text}</p>}
    {waiting && <p>{outcome.agent_name || "The agent"} hasn't picked it up yet. It will see it when its session resumes.</p>}
    {outcome.reply && <p className="whitespace-pre-wrap">{outcome.reply.agent_name}: "{outcome.reply.text}"</p>}
    {outcome.page_id && outcome.task_id && <a className="text-accent underline" href={taskUrl(outcome.page_id, outcome.task_id)}>Open task</a>}
  </div>;
}

export interface AssistantThreadViewProps {
  messages: PersonMessage[];
  draft: string;
  reviewing: boolean;
  busy?: boolean;
  error: string | null;
  voice: ReactNode;
  decisions?: ReactNode;
  avatar?: ReactNode;
  empty?: ReactNode;
  onSendMessage?: (message: PersonMessage, addRequirement?: boolean) => void;
  onDeclineWork?: (message: PersonMessage) => void;
  onPropose?: (message: PersonMessage) => void;
  onSettleAgent?: (message: PersonMessage, accept: boolean) => void;
  hasTaskDatabase?: boolean;
  agentProposalError?: boolean;
  proposing?: { id: string; action: "start" | "decline" | "agent" | "message" } | null;
  onDraft: (text: string) => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onRetrySend: (() => void) | null;
  onUndo: (noteId: string) => void;
  onOpenNotes: () => void;
  onNewConversation?: () => void;
  resetting?: boolean;
  scrollRequest?: number;
  status?: string | null;
}

// Pure view of the conversation with the workspace agent. P12 mounts it in its own surface.
export function AssistantThreadView({ messages, draft, reviewing, busy = false, error, voice, decisions, avatar, empty, onPropose, onDeclineWork, onSendMessage, onSettleAgent, hasTaskDatabase, agentProposalError, proposing, onDraft, onPaste, onSend, onRetrySend, onUndo, onOpenNotes, onNewConversation, resetting, scrollRequest = 0, status = null }: AssistantThreadViewProps) {
  const { listRef, contentRef, onScroll, scrollToLatest, showScrollToLatest } = useConversationScroll(messages, scrollRequest);
  const hasUserMessage = messages.some((message) => message.direction === "in" && message.kind !== "system");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 w-full flex-col gap-3 text-sm">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-1 pb-2">
        <span className="flex shrink-0 items-center gap-2">
          {avatar}
          <span className="flex flex-col items-start gap-1">
            <span className="font-medium leading-4">Trama</span>
            {hasUserMessage && <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-accent/15 bg-accent/5 px-1.5 py-0.5 text-[10px] leading-[14px] text-[#196eb9] dark:text-[#8fc5ff]">
              <Sparkles size={10} strokeWidth={1.8} aria-hidden="true" />
              <span>Powered by <span className="font-semibold">Muse</span></span>
            </span>}
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col items-end gap-1">
          {onNewConversation && messages.length > 0 && <button type="button" className="max-w-full text-right text-xs text-text-secondary underline disabled:opacity-50" disabled={resetting} onClick={onNewConversation}>New conversation</button>}
          <button type="button" className="max-w-full text-right text-xs text-text-secondary underline" onClick={onOpenNotes}>Open notes</button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The scrollable message log needs keyboard access. */}
        <div ref={listRef} onScroll={onScroll} role="log" aria-label="Conversation with Trama" aria-live="polite" aria-relevant="additions text" aria-atomic="false" tabIndex={0}
          className="h-full overflow-y-auto overscroll-contain rounded-lg px-1 [overflow-anchor:none] focus-visible:outline-2 focus-visible:outline-accent">
          <ol ref={contentRef} className="space-y-4 py-2">
            {messages.length === 0 && <li className="py-2 text-xs text-text-tertiary">{empty ?? "Write or talk to the agent. Say “save in notes” to keep something."}</li>}
            {messages.map((m) => (
              <li key={m.id} className={`flex ${m.direction === "in" ? "justify-end" : "justify-start"}`}>
                <div className={`flex min-w-0 max-w-[88%] flex-col gap-1 ${m.direction === "in" ? "items-end" : "items-start"}`}>
                  <span className="flex items-center gap-1 px-1 text-xs font-medium text-text">
                    {m.direction === "out" && <TramaAvatar size={24} decorative />}
                    {m.direction === "in" ? "You" : "Trama"}
                  </span>
                  <div className={`min-w-0 rounded-2xl px-3 py-2.5 ${m.direction === "in" ? "rounded-tr-md bg-[#196eb9] text-white" : "rounded-tl-md border border-border bg-bg-secondary text-text"}`}>
                    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed">{m.direction === "out" ? appLinks(m.body) : m.body}</p>
                    {m.outcome?.kind === "memory_added" && <a href={settingsUrl("memory")} className="text-accent underline">Manage</a>}
                    {m.direction === "out" && !!m.outcome?.memory_used?.length && <div className="mt-2 text-xs text-text-secondary">
                      {m.outcome.memory_used.map((memory) => <p key={memory.id}>Used: {memory.text}</p>)}
                      <a href={settingsUrl("memory")} className="text-accent underline">Manage</a>
                    </div>}
                    {(m.kind === "voice" || m.forwarded || m.channel !== "surface") && (
                      <p className={`mt-1 text-xs ${m.direction === "in" ? "text-white/90" : "text-text-secondary"}`}>{[m.channel === "telegram" ? "Telegram" : null, m.kind === "voice" ? "voice" : null, m.forwarded ? "forwarded" : null].filter(Boolean).join(" · ")}</p>
                    )}
                    {m.outcome?.job && <p className={`mt-2 ${m.outcome.kind === "work_declined" ? "text-text-secondary" : ""}`}>Lead: {m.outcome.job.lead.name} · Workers: {m.outcome.job.workers.map((a) => a.name).join(", ") || "none"}</p>}
                    {m.outcome?.kind === "work_proposed" && onPropose && (
                      <div className={m.outcome.summary ? "mt-2 space-y-1 rounded border border-border bg-bg-secondary p-3" : "mt-1"}>
                        {m.outcome.summary && <><p className="font-medium">{m.outcome.job ? "Start this job?" : "Start this work?"}</p><p>{m.outcome.job ? `New job on ${m.outcome.job.board_title}: ${m.outcome.job.title}` : `On ${m.outcome.page_title || "this page"}`}</p><p className="whitespace-pre-wrap">{m.outcome.summary}</p></>}
                        <div className="flex gap-2 pt-2">
                          <button type="button" aria-label={`Do it on ${m.outcome.page_title || "this page"}`} className="min-h-9 rounded bg-accent px-3 text-white disabled:opacity-50" disabled={proposing?.id === m.id} onClick={() => onPropose(m)}>{proposing?.id === m.id && proposing.action === "start" ? "Starting…" : "Do it"}</button>
                          {m.outcome.summary && onDeclineWork && <button type="button" aria-label={`Not now on ${m.outcome.page_title || "this page"}`} className="min-h-9 rounded border border-border px-3 disabled:opacity-50" disabled={proposing?.id === m.id} onClick={() => onDeclineWork(m)}>{proposing?.id === m.id && proposing.action === "decline" ? "Closing…" : "Not now"}</button>}
                        </div>
                      </div>
                    )}
                    {(m.outcome?.kind === "work_started" || m.outcome?.kind === "work_declined") && !m.outcome.text && <div className={`mt-2 space-y-1 ${m.outcome.kind === "work_declined" ? "text-text-secondary" : ""}`}>
                      <p>{m.outcome.kind === "work_started" ? "Started." : "Not started."}</p>
                      {m.outcome.summary && <><p>On {m.outcome.page_title || "this page"}</p><p className="whitespace-pre-wrap">{m.outcome.summary}</p></>}
                      {m.outcome.kind === "work_started" && m.outcome.page_id && m.outcome.task_id && <a className="text-accent underline" href={taskUrl(m.outcome.page_id, m.outcome.task_id)}>{m.outcome.job ? "Open job" : "Open task"}</a>}
                    </div>}
                    {m.outcome?.kind === "message_proposed" && <div className="mt-2 space-y-1 rounded border border-border p-3">
                      <p className="font-medium">{m.outcome.adds_requirement ? "Add to the brief and tell" : "Send to"} {m.outcome.agent_name}?</p><p>On {m.outcome.task_title}</p><p className="whitespace-pre-wrap">{m.outcome.text}</p>
                      <div className="flex gap-2 pt-2"><button type="button" aria-label={`${m.outcome.adds_requirement ? "Add and send" : "Send"} to ${m.outcome.agent_name}`} disabled={proposing?.id === m.id || !onSendMessage} className="min-h-9 rounded bg-accent px-3 text-white disabled:opacity-50" onClick={() => onSendMessage?.(m, m.outcome?.adds_requirement === true)}>{proposing?.id === m.id && proposing.action === "message" ? "Sending…" : m.outcome.adds_requirement ? "Add and send" : "Send"}</button>
                      {m.outcome.adds_requirement && <button type="button" aria-label={`Send only to ${m.outcome.agent_name}`} disabled={proposing?.id === m.id || !onSendMessage} className="min-h-9 rounded border border-border px-3 disabled:opacity-50" onClick={() => onSendMessage?.(m, false)}>Send only</button>}
                      <button type="button" aria-label={`Not now for ${m.outcome.agent_name}`} disabled={proposing?.id === m.id || !onDeclineWork} className="min-h-9 rounded border border-border px-3 disabled:opacity-50" onClick={() => onDeclineWork?.(m)}>{proposing?.id === m.id && proposing.action === "decline" ? "Closing…" : "Not now"}</button></div>
                    </div>}
                    {m.outcome?.kind === "message_sent" && <SentMessage outcome={m.outcome} />}
                    {m.outcome?.kind === "work_declined" && m.outcome.text && <div className="mt-2 space-y-1 text-text-secondary"><p>Not sent.</p><p className="whitespace-pre-wrap">{m.outcome.text}</p></div>}
                    {m.outcome?.kind === "agent_proposed" && onSettleAgent ? <div className="mt-2 space-y-1 rounded border border-border bg-bg-secondary p-3">
                      <p className="font-medium">Create this agent?</p><p>Name: {m.outcome.name}</p><p>Works with: {CONNECT_AGENT_NAMES[m.outcome.harness ?? ""] ?? m.outcome.harness}</p><p>Role: {m.outcome.role === "lead" ? "Lead" : "Worker"}</p><p>Page access: {hasTaskDatabase ? "Agent Tasks" : "none yet"}</p>
                      <div className="flex gap-2 pt-2"><button type="button" className="min-h-9 rounded bg-accent px-3 text-white disabled:opacity-50" disabled={proposing?.id === m.id} onClick={() => onSettleAgent(m, true)}>Create agent</button><button type="button" className="min-h-9 rounded border border-border px-3 disabled:opacity-50" disabled={proposing?.id === m.id} onClick={() => onSettleAgent(m, false)}>Cancel</button></div>
                    </div> : null}
                    {m.outcome?.kind === "agent_accepted" ? <p className="mt-2">{m.outcome.name} is ready. <a className="text-accent underline" href={connectUrl(m.outcome.harness)}>Connect {m.outcome.name}</a></p> : null}
                    {m.outcome?.kind === "agent_declined" ? <p className="mt-2">Cancelled.</p> : null}
                    {m.outcome?.kind === "note_saved" && m.outcome.note_id && (
                      <button type="button" className="text-xs text-text-secondary underline" onClick={() => onUndo(m.outcome?.note_id as string)}>Undo</button>
                    )}
                  </div>
                </div>
              </li>
            ))}
            {status && <li className="flex items-center gap-2 px-1 py-2 text-xs text-text-secondary"><TramaAvatar size={24} decorative /><span>{status}</span></li>}
          </ol>
        </div>
        {showScrollToLatest && <button type="button" onClick={() => { scrollToLatest(); listRef.current?.focus({ preventScroll: true }); }} style={{ backgroundColor: "var(--bg)" }}
          className="absolute bottom-2 left-1/2 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-text shadow-md">
          <ArrowDown size={14} aria-hidden="true" />Latest messages
        </button>}
      </div>
      {error && (
        <p className="shrink-0 px-1 text-xs text-red-600" role="alert">
          {error}{" "}
          {agentProposalError ? <a href={settingsUrl("agents")} className="underline">Settings → Agents</a> : null}
          {onRetrySend && <button type="button" className="underline" onClick={onRetrySend}>Try again</button>}
        </p>
      )}
      {decisions}
      {reviewing && <p className="shrink-0 px-1 text-xs text-text-secondary">Check the text before sending. {VOICE_NOTICE}</p>}
      <div className="flex shrink-0 items-end gap-1">
        <textarea
          className="min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-border bg-transparent px-3 py-2"
          aria-label="Message to the agent"
          placeholder="Message Trama…"
          rows={2}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy) onSend();
            }
          }}
        />
        {voice}
        <button type="button" className="icon-button" aria-label="Send" disabled={busy || !draft.trim()} onClick={onSend}><Send size={16} /></button>
      </div>
    </div>
  );
}
