"use client";

import { ArrowDown, Send } from "lucide-react";
import type { ClipboardEvent, ReactNode } from "react";
import { TramaAvatar } from "@/components/agents/TramaAvatar";
import { useConversationScroll } from "@/components/agents/assistant/useConversationScroll";
import type { PersonMessage } from "@/lib/agentConversation";
import { VOICE_NOTICE } from "@/lib/agentVoice";
import { CONNECT_AGENT_NAMES } from "@/lib/agentConnectCatalog";
import { connectUrl, settingsUrl } from "@/lib/routes";
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

export interface AssistantThreadViewProps {
  messages: PersonMessage[];
  draft: string;
  reviewing: boolean;
  busy?: boolean;
  error: string | null;
  voice: ReactNode;
  avatar?: ReactNode;
  empty?: ReactNode;
  onPropose?: (message: PersonMessage) => void;
  onSettleAgent?: (message: PersonMessage, accept: boolean) => void;
  hasTaskDatabase?: boolean;
  agentProposalError?: boolean;
  proposing?: string | null;
  onDraft: (text: string) => void;
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
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
export function AssistantThreadView({ messages, draft, reviewing, busy = false, error, voice, avatar, empty, onPropose, onSettleAgent, hasTaskDatabase, agentProposalError, proposing, onDraft, onPaste, onSend, onRetrySend, onUndo, onOpenNotes, onNewConversation, resetting, scrollRequest = 0, status = null }: AssistantThreadViewProps) {
  const { listRef, contentRef, onScroll, scrollToLatest, showScrollToLatest } = useConversationScroll(messages, scrollRequest);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 w-full flex-col gap-3 text-sm">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-1 pb-2">
        <span className="flex items-center gap-2 font-medium">{avatar}Trama</span>
        <span className="flex gap-3">
          {onNewConversation && messages.length > 0 && <button type="button" className="text-xs text-text-secondary underline disabled:opacity-50" disabled={resetting} onClick={onNewConversation}>New conversation</button>}
          <button type="button" className="text-xs text-text-secondary underline" onClick={onOpenNotes}>Open notes</button>
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
                    {(m.kind === "voice" || m.forwarded || m.channel !== "surface") && (
                      <p className={`mt-1 text-xs ${m.direction === "in" ? "text-white/90" : "text-text-secondary"}`}>{[m.channel === "telegram" ? "Telegram" : null, m.kind === "voice" ? "voice" : null, m.forwarded ? "forwarded" : null].filter(Boolean).join(" · ")}</p>
                    )}
                    {m.outcome?.kind === "work_proposed" && onPropose && (
                      <button type="button" className="mt-1 rounded bg-accent px-3 py-1 text-white disabled:opacity-50" disabled={proposing === m.id} onClick={() => onPropose(m)}>{proposing === m.id ? "Starting…" : "Do it"}</button>
                    )}
                    {m.outcome?.kind === "agent_proposed" && onSettleAgent ? <div className="mt-2 space-y-1 rounded border border-border bg-bg-secondary p-3">
                      <p className="font-medium">Create this agent?</p><p>Name: {m.outcome.name}</p><p>Works with: {CONNECT_AGENT_NAMES[m.outcome.harness ?? ""] ?? m.outcome.harness}</p><p>Role: {m.outcome.role === "lead" ? "Lead" : "Worker"}</p><p>Page access: {hasTaskDatabase ? "Agent Tasks" : "none yet"}</p>
                      <div className="flex gap-2 pt-2"><button type="button" className="min-h-9 rounded bg-accent px-3 text-white disabled:opacity-50" disabled={proposing === m.id} onClick={() => onSettleAgent(m, true)}>Create agent</button><button type="button" className="min-h-9 rounded border border-border px-3 disabled:opacity-50" disabled={proposing === m.id} onClick={() => onSettleAgent(m, false)}>Cancel</button></div>
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
