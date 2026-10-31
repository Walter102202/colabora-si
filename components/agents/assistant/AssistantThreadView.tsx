"use client";

import { Send } from "lucide-react";
import type { ClipboardEvent, ReactNode } from "react";
import type { PersonMessage } from "@/lib/agentConversation";
import { VOICE_NOTICE } from "@/lib/agentVoice";

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
  proposing?: string | null;
  onDraft: (text: string) => void;
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onRetrySend: (() => void) | null;
  onUndo: (noteId: string) => void;
  onOpenNotes: () => void;
}

// Pure view of the conversation with the workspace agent. P12 mounts it in its own surface.
export function AssistantThreadView({ messages, draft, reviewing, busy = false, error, voice, avatar, empty, onPropose, proposing, onDraft, onPaste, onSend, onRetrySend, onUndo, onOpenNotes }: AssistantThreadViewProps) {
  return (
    <div className="flex min-h-0 h-96 max-h-[60vh] w-full flex-col gap-2 text-sm">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="flex items-center gap-2 font-medium">{avatar}Trama</span>
        <button type="button" className="text-xs text-text-secondary underline" onClick={onOpenNotes}>Open notes</button>
      </div>
      <ol className="min-h-0 flex-1 space-y-1 overflow-auto px-1" aria-label="Conversation with the agent" aria-live="polite">
        {messages.length === 0 && <li className="py-2 text-xs text-text-tertiary">{empty ?? "Write or talk to the agent. Say “save in notes” to keep something."}</li>}
        {messages.map((m) => (
          <li key={m.id} className={m.direction === "in" ? "ml-6 rounded bg-bg-secondary px-2 py-1" : "mr-6 px-2 py-1"}>
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
            {(m.kind === "voice" || m.forwarded || m.channel !== "surface") && (
              <p className="text-xs text-text-tertiary">{[m.channel === "telegram" ? "Telegram" : null, m.kind === "voice" ? "voice" : null, m.forwarded ? "forwarded" : null].filter(Boolean).join(" · ")}</p>
            )}
            {m.outcome?.kind === "work_proposed" && onPropose && (
              <button type="button" className="mt-1 rounded bg-accent px-3 py-1 text-white disabled:opacity-50" disabled={proposing === m.id} onClick={() => onPropose(m)}>{proposing === m.id ? "Starting…" : "Do it"}</button>
            )}
            {m.outcome?.kind === "note_saved" && m.outcome.note_id && (
              <button type="button" className="text-xs text-text-secondary underline" onClick={() => onUndo(m.outcome?.note_id as string)}>Undo</button>
            )}
          </li>
        ))}
      </ol>
      {error && (
        <p className="px-1 text-xs text-red-600" role="alert">
          {error}{" "}
          {onRetrySend && <button type="button" className="underline" onClick={onRetrySend}>Try again</button>}
        </p>
      )}
      {reviewing && <p className="px-1 text-xs text-text-secondary">Check the text before sending. {VOICE_NOTICE}</p>}
      <div className="flex items-end gap-1">
        <textarea
          className="min-h-9 flex-1 resize-none rounded border border-border bg-transparent px-2 py-1"
          aria-label="Message to the agent"
          rows={2}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
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
