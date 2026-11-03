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
  it("identifies each speaker and announces new messages as a conversation log", () => {
    const host = document.createElement("div");
    host.innerHTML = view({ messages: [message({ body: "My question" }), message({ id: "reply", direction: "out", body: "Trama's answer" })] });
    const log = host.querySelector('[role="log"]')!;
    expect(log.getAttribute("aria-label")).toBe("Conversation with Trama");
    expect(log.getAttribute("aria-relevant")).toBe("additions text");
    const entries = log.querySelectorAll("li");
    expect(entries[0].textContent).toBe("YouMy question");
    expect(entries[1].textContent).toBe("TramaTrama's answer");
    expect(entries[1].querySelector("img")?.getAttribute("alt")).toBe("");
  });
  it.each(["in", "out"] as const)("links only app URLs in outgoing replies (direction=%s)", (direction) => {
    const url = `${window.location.origin}/p/budget?task=t`;
    const body = `Review ${url}.\nhttps://other.test/p/private javascript:alert(1)`;
    const host = document.createElement("div");
    host.innerHTML = view({ messages: [message({ direction, body })] });
    const paragraph = host.querySelector("li p")!;
    expect(paragraph.textContent).toBe(body);
    expect(paragraph.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect([...paragraph.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(direction === "out" ? [url] : []);
  });
  it("offers a new conversation only with messages and an action", () => {
    expect(view({ messages: [message({})], onNewConversation: noop })).toContain("New conversation");
    expect(view({ messages: [], onNewConversation: noop })).not.toContain("New conversation");
    expect(view({ messages: [message({})] })).not.toContain("New conversation");
    expect(view({ messages: [message({})], onNewConversation: noop, resetting: true })).toMatch(/disabled="">New conversation/);
  });
  it.each(["agent_proposed", "agent_accepted", "agent_declined"])("renders the %s state without a token", (kind) => {
    const html = view({ messages: [message({ direction: "out", outcome: { kind, name: "Helper", harness: "codex", role: "lead" } })], onSettleAgent: noop, hasTaskDatabase: true });
    if (kind === "agent_proposed") { expect(html).toContain("Create this agent?"); expect(html).toContain("Works with: Codex"); expect(html).toContain("Role: Lead"); expect(html).toContain("Page access: Agent Tasks"); expect(html).toContain("Create agent"); }
    if (kind === "agent_accepted") { expect(html).toContain("Helper is ready."); expect(html).toContain('href="/connect/codex"'); }
    if (kind === "agent_declined") expect(html).toContain("Cancelled.");
    expect(html).not.toContain("agt_");
  });
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

it.each(["work_proposed", "work_started", "work_declined", "legacy"])("renders durable work card: %s", (state) => {
  const host = document.createElement("div");
  host.innerHTML = view({ messages: [message({ direction: "out", outcome: { kind: state === "legacy" ? "work_proposed" : state, page_id: "home", task_id: "task", page_title: "Home", ...(state === "legacy" ? {} : { summary: "Create five tasks on Home." }) } })], onPropose: noop, onDeclineWork: noop });
  if (state === "work_proposed") {
    expect(host.textContent).toContain("Start this work?On HomeCreate five tasks on Home.");
    expect(host.querySelector('[aria-label="Do it on Home"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Not now on Home"]')).not.toBeNull();
  } else if (state === "legacy") expect(host.textContent).toContain("Do it");
  else {
    expect(host.textContent).not.toContain("Do it");
    expect(host.textContent).toContain("On Home");
    const summary = [...host.querySelectorAll("p")].find((p) => p.textContent === "Create five tasks on Home.")!;
    expect(summary).toBeDefined();
    expect(summary.classList.contains("whitespace-pre-wrap")).toBe(true);
    if (state === "work_declined") expect(summary.closest(".text-text-secondary")).not.toBeNull();
    expect(host.textContent).toContain(state === "work_started" ? "Started." : "Not started.");
    if (state === "work_started") expect(host.querySelector('a')?.getAttribute("href")).toBe("/p/home?task=task");
  }
});

it.each(["work_proposed", "work_started", "work_declined"])("shows the proposed job team in %s", (kind) => {
  const html = view({ messages: [message({ direction: "out", outcome: { kind, page_id: "row", task_id: "task", summary: "Codex researches; Claude reviews.", job: { board_id: "b", board_title: "Jobs", title: "Offsite", lead: { id: "l", name: "Claude" }, workers: [{ id: "w", name: "Codex" }] } } })], onPropose: noop, onDeclineWork: noop });
  expect(html).toContain("Lead: Claude"); expect(html).toContain("Workers: Codex"); expect(html).toContain("Codex researches; Claude reviews.");
  if (kind === "work_proposed") { expect(html).toContain("Start this job?"); expect(html).toContain("New job on Jobs: Offsite"); }
  if (kind === "work_started") { expect(html).toContain("Open job"); expect(html).toContain('href="/p/row?task=task"'); }
});

it.each(["message_proposed", "message_sent", "work_declined"])("renders a confirmed message as %s", (kind) => {
  const html = view({ messages: [message({ direction: "out", outcome: { kind, task_id: "task", task_title: "Research", page_id: "row", agent_name: "Codex", text: "Use local dates." } })], onSendMessage: noop, onDeclineWork: noop });
  if (kind === "message_proposed") { expect(html).toContain("Send to Codex?"); expect(html).toContain("On Research"); expect(html).toContain("Use local dates."); expect(html).toContain('aria-label="Send to Codex"'); }
  if (kind === "message_sent") { expect(html).toContain("Sent to Codex."); expect(html).toContain("On Research"); expect(html).toContain("Use local dates."); expect(html).toContain('href="/p/row?task=task"'); }
  if (kind === "work_declined") { expect(html).toContain("Not sent."); expect(html).toContain("Use local dates."); }
});
