"use client";

import { Loader2, Mic, RotateCcw, Square, X } from "lucide-react";
import { MAX_RECORDING_MS, VOICE_NOTICE, voiceFailureText, type VoiceState } from "@/lib/agentVoice";

export interface VoiceButtonProps {
  state: VoiceState;
  elapsedMs: number;
  onPress: () => void;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

// Pure view: every state of a recording, with what the person can do from it. Space and Enter work, because it is a button.
export function VoiceButton({ state, elapsedMs, onPress, onStop, onCancel, onRetry }: VoiceButtonProps) {
  if (state.phase === "recording") {
    return (
      <div className="flex items-center gap-1" role="status" aria-live="polite">
        <span className="text-xs tabular-nums text-text-secondary">Recording {clock(elapsedMs)} / {clock(MAX_RECORDING_MS)}</span>
        <button type="button" className="icon-button" aria-label="Stop and transcribe" onClick={onStop}><Square size={15} /></button>
        <button type="button" className="icon-button" aria-label="Cancel recording" onClick={onCancel}><X size={15} /></button>
      </div>
    );
  }
  if (state.phase === "asking" || state.phase === "sending" || state.phase === "transcribing") {
    const label = state.phase === "asking" ? "Waiting for the microphone" : state.phase === "sending" ? "Sending" : "Transcribing";
    return <span className="flex items-center gap-1 text-xs text-text-secondary" role="status" aria-live="polite"><Loader2 size={14} className="animate-spin" />{label}…</span>;
  }
  if (state.phase === "failed") {
    return (
      <div className="flex items-center gap-1" role="alert">
        <span className="text-xs text-red-600">{voiceFailureText(state.reason)}</span>
        {state.canRetry
          ? <button type="button" className="icon-button" aria-label="Try again" onClick={onRetry}><RotateCcw size={15} /></button>
          : <button type="button" className="icon-button" aria-label="Record again" onClick={onPress}><Mic size={15} /></button>}
        <button type="button" className="icon-button" aria-label="Dismiss" onClick={onCancel}><X size={15} /></button>
      </div>
    );
  }
  return <button type="button" className="icon-button" aria-label="Talk to the agent" title={VOICE_NOTICE} onClick={onPress}><Mic size={16} /></button>;
}
