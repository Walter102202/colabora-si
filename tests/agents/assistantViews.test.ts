// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AssistantThreadView, type AssistantThreadViewProps } from "@/components/agents/assistant/AssistantThreadView";
import { VoiceButton } from "@/components/agents/assistant/VoiceButton";
import type { PersonMessage } from "@/lib/agentConversation";
import type { VoiceState } from "@/lib/agentVoice";

const noop = () => {};
const button = (state: VoiceState, elapsedMs = 0) => renderToStaticMarkup(createElement(VoiceButton, { state, elapsedMs, onPress: noop, onStop: noop, onCancel: noop, onRetry: noop }));

describe("VoiceButton", () => {
  it("at rest offers to talk and says what happens to the audio", () => {
    const html = button({ phase: "idle" });
    expect(html).toContain('aria-label="Talk to the agent"');
    expect(html).toContain("is not kept");
  });
  it.each([
    [{ phase: "asking" }, "Waiting for the microphone"], [{ phase: "sending" }, "Sending"], [{ phase: "transcribing" }, "Transcribing"],
  ] as [VoiceState, string][])("%j says so in a live region", (state, words) => {
    const html = button(state);
    expect(html).toContain(words);
    expect(html).toContain('role="status"');
  });
  it("while recording shows the time left and a way out", () => {
    const html = button({ phase: "recording", startedAt: 0 }, 65000);
    expect(html).toContain("1:05");
    expect(html).toContain("5:00");
    expect(html).toContain('aria-label="Stop and transcribe"');
    expect(html).toContain('aria-label="Cancel recording"');
  });
  it("a failure that can be retried offers it", () => {
    expect(button({ phase: "failed", reason: "voice_busy", canRetry: true })).toContain('aria-label="Try again"');
  });
  it("a denied microphone explains and keeps the keyboard", () => {
    const html = button({ phase: "failed", reason: "mic_denied", canRetry: false });
    expect(html).toContain("type your message");
    expect(html).not.toContain('aria-label="Try again"');
  });
});

const message = (over: Partial<PersonMessage>): PersonMessage => ({ id: "m", seq: 1, workspace_id: "w", direction: "in", channel: "surface", kind: "text", body: "hola", forwarded: false, outcome: null, created_at: "", ...over });
const view = (over: Partial<AssistantThreadViewProps>) => renderToStaticMarkup(createElement(AssistantThreadView, {
  messages: [], draft: "", reviewing: false, error: null, voice: null, onDraft: noop, onPaste: noop, onSend: noop, onRetrySend: null, onUndo: vi.fn(), onOpenNotes: noop, ...over,
}));

describe("AssistantThreadView", () => {
  it("empty, it says how to keep something", () => {
    expect(view({})).toContain("save in notes");
  });
  it("a saved note offers Undo", () => {
    expect(view({ messages: [message({ direction: "out", kind: "system", body: "Guardado", outcome: { kind: "note_saved", note_id: "n" } })] })).toContain("Undo");
  });
  it("nothing else does", () => {
    expect(view({ messages: [message({ outcome: { kind: "for_agent" } })] })).not.toContain("Undo");
  });
  it("marks where a message came from", () => {
    expect(view({ messages: [message({ channel: "telegram", kind: "voice", forwarded: true })] })).toContain("Telegram · voice · forwarded");
  });
  it("a transcript under review says to check it and what happens to the audio", () => {
    const html = view({ reviewing: true, draft: "hola" });
    expect(html).toContain("Check the text before sending");
    expect(html).toContain("not kept");
  });
  it("a failed send keeps the way back", () => {
    expect(view({ error: "No", onRetrySend: noop })).toContain("Try again");
  });
  it("an empty box cannot be sent", () => {
    expect(view({})).toMatch(/aria-label="Send" disabled/);
  });
  it("renders message text as text", () => {
    expect(view({ messages: [message({ body: "<img src=x onerror=alert(1)>" })] })).not.toContain("<img");
  });
});
