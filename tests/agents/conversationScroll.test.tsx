// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationScroll } from "@/components/agents/assistant/useConversationScroll";
import type { PersonMessage } from "@/lib/agentConversation";

const message = (id: string, seq: number, over: Partial<PersonMessage> = {}): PersonMessage => ({
  id, seq, workspace_id: "workspace", direction: "out", channel: "surface", kind: "text", body: id,
  forwarded: false, outcome: null, created_at: "2026-11-02T12:00:00Z", ...over,
});

let root: Root;
let host: HTMLDivElement;
let height: number;
let viewportHeight: number;
let top: number;
let resize: () => void;
const observe = vi.fn();
const disconnect = vi.fn();

function Thread({ messages, request = 0 }: { messages: PersonMessage[]; request?: number }) {
  const { listRef, contentRef, onScroll, scrollToLatest, showScrollToLatest } = useConversationScroll(messages, request);
  return <>
    <div data-viewport ref={listRef} onScroll={onScroll}>
      <ol ref={contentRef}>{messages.map((m) => <li key={m.id}>{m.body}</li>)}</ol>
    </div>
    {showScrollToLatest && <button onClick={scrollToLatest}>Latest messages</button>}
  </>;
}

const render = (messages: PersonMessage[], request = 0) => act(() => root.render(<Thread messages={messages} request={request} />));
const viewport = () => host.querySelector<HTMLDivElement>("[data-viewport]")!;
const jumpButton = () => host.querySelector<HTMLButtonElement>("button");
function scrollTo(value: number) {
  act(() => {
    viewport().scrollTop = value;
    viewport().dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  height = 1000; viewportHeight = 300; top = 0;
  observe.mockClear(); disconnect.mockClear();
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight);
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(() => top);
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation((value) => { top = Math.max(0, Math.min(value, height - viewportHeight)); });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("conversation scrolling", () => {
  it("opens at the latest message and follows a history load after an empty mount", () => {
    height = 100; render([]); expect(top).toBe(0);
    height = 1000; render([message("hello", 1), message("latest", 2)]);
    expect(top).toBe(700); expect(jumpButton()).toBeNull();
  });

  it("follows new replies and updates to an existing reply while at the bottom", () => {
    const first = message("one", 1); render([first]);
    height = 1200; render([first, message("reply", 2)]); expect(top).toBe(900);
    height = 1500; render([first, message("reply", 2, { body: "A longer reply" })]); expect(top).toBe(1200);
    expect(jumpButton()).toBeNull();
  });

  it("leaves older messages in place when a reply arrives or metadata refreshes", () => {
    const first = message("one", 1); render([first]); scrollTo(250);
    height = 1200; render([first, message("reply", 2)]);
    expect(top).toBe(250); expect(jumpButton()?.textContent).toBe("Latest messages");
    render([{ ...first, needs_reply: false }, message("reply", 2)]);
    expect(top).toBe(250);
  });

  it("resumes immediately for an explicit send, then follows the delayed message and reply", () => {
    const first = message("one", 1); render([first]); scrollTo(250);
    render([first], 1); expect(top).toBe(700); expect(jumpButton()).toBeNull();
    const own = message("own", 2, { direction: "in" });
    height = 1200; render([first, own], 1); expect(top).toBe(900);
    height = 1400; render([first, own, message("reply", 3)], 1); expect(top).toBe(1100);
  });

  it("the latest-messages button resumes following without changing document scroll", () => {
    const documentScroll = vi.spyOn(window, "scrollTo");
    const first = message("one", 1); render([first]); scrollTo(250);
    act(() => jumpButton()!.click()); expect(top).toBe(700); expect(jumpButton()).toBeNull();
    height = 1200; render([first, message("reply", 2)]); expect(top).toBe(900);
    expect(documentScroll).not.toHaveBeenCalled();
  });

  it("resumes following when the person manually returns close to the bottom", () => {
    const first = message("one", 1); render([first]); scrollTo(250); scrollTo(680);
    expect(jumpButton()).toBeNull();
    height = 1200; render([first, message("reply", 2)]); expect(top).toBe(900);
  });

  it("observes content and viewport sizes and follows late layout changes", () => {
    render([message("one", 1)]);
    expect(observe.mock.calls.map(([node]) => node)).toEqual([viewport(), host.querySelector("ol")]);
    height = 1200; act(() => resize()); expect(top).toBe(900);
    viewportHeight = 200; act(() => resize()); expect(top).toBe(1000);
    scrollTo(250); height = 1400; act(() => resize()); expect(top).toBe(250);
  });

  it("does not mistake a scroll event after content growth for reading older messages", () => {
    render([message("one", 1)]);
    height = 1400;
    act(() => viewport().dispatchEvent(new Event("scroll")));
    act(() => resize());
    expect(top).toBe(1100); expect(jumpButton()).toBeNull();
  });

  it("starts at the latest message after a new conversation or workspace replaces the thread", () => {
    render([message("one", 1), message("two", 2)]); scrollTo(250);
    render([message("new-topic", 3)]); expect(top).toBe(700);
    scrollTo(250); render([message("other", 1, { workspace_id: "other-workspace" })]); expect(top).toBe(700);
    scrollTo(250); height = 100; render([]); expect(top).toBe(0); expect(jumpButton()).toBeNull();
    height = 1000; render([message("fresh", 4)]); expect(top).toBe(700);
  });

  it("disconnects size observation when the chat closes", () => {
    render([message("one", 1)]); act(() => root.render(null));
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
