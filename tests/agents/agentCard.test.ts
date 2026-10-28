// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { approvalLink, cardDataFrom, pageLink, taskIdFrom, taskLink, toolFailure } from "@/lib/agentCard";
import { windowPort } from "@/lib/agentCardHost";
import { applyHostContext, applySystemTheme } from "@/components/agents/card/theme";
import { mockCard } from "@/components/agents/card/mock";

describe("card data contract", () => {
  it("recognizes the task and waiting shapes and nothing else", () => {
    const task = mockCard("1");
    const list = mockCard("list");
    expect(cardDataFrom(task)?.kind).toBe("task");
    expect(cardDataFrom(list)?.kind).toBe("waiting");
    expect(cardDataFrom({ kind: "task" })).toBeNull();
    expect(cardDataFrom({ activity_id: "x", delivery: "queued" })).toBeNull();
    expect(cardDataFrom(null)).toBeNull();
    expect(cardDataFrom("task")).toBeNull();
  });

  it("reads a failure from structuredContent, with the text as fallback", () => {
    expect(toolFailure({ isError: false, structuredContent: { code: "x", message: "no" } })).toBeNull();
    expect(toolFailure({ isError: true, structuredContent: { code: "direct_session_required", message: "Open the app.", detail: { url: "https://a/p/1" } } }))
      .toEqual({ code: "direct_session_required", message: "Open the app.", detail: { url: "https://a/p/1" } });
    expect(toolFailure({ isError: true, content: [{ type: "text", text: "Error timeout: too slow\n\n{}" }] })).toEqual({ code: "error", message: "Error timeout: too slow", detail: null });
    expect(toolFailure({ isError: true })).toEqual({ code: "error", message: "The tool call failed.", detail: null });
  });

  it("builds deep links on app_url with the app's route builders", () => {
    expect(taskLink("https://app.example/", "row 1", "t1")).toBe("https://app.example/p/row%201?task=t1");
    expect(pageLink("https://app.example", "p1")).toBe("https://app.example/p/p1");
    expect(approvalLink("https://app.example.com/", "p1", "t1", "ap 1")).toBe("https://app.example.com/p/p1?task=t1#approval-ap%201");
    expect(taskIdFrom({ task_id: "t1" })).toBe("t1");
    expect(taskIdFrom({ task_id: "" })).toBeNull();
    expect(taskIdFrom("t1")).toBeNull();
  });
});

describe("card theme", () => {
  it("follows the host theme and maps its style variables onto the card tokens", () => {
    applyHostContext({
      theme: "dark",
      locale: "es-CL",
      styles: { variables: { "--color-background-primary": "#30302E", "--color-text-primary": "#FAF9F5", "--font-sans": "Anthropic Sans, sans-serif" }, css: { fonts: "@font-face { font-family: X; }" } },
      safeAreaInsets: { top: 0, right: 8, bottom: 16, left: 8 },
    });
    const root = document.documentElement;
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.getPropertyValue("--bg")).toBe("#30302E");
    expect(root.style.getPropertyValue("--text")).toBe("#FAF9F5");
    expect(root.style.getPropertyValue("--font-sans")).toBe("Anthropic Sans, sans-serif");
    expect(root.style.getPropertyValue("--safe-bottom")).toBe("16px");
    expect(root.lang).toBe("es-CL");
    expect(document.getElementById("host-fonts")?.textContent).toContain("font-family: X");

    applyHostContext({ theme: "light" });
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.getPropertyValue("--bg")).toBe("#30302E");
    applySystemTheme();
    expect(typeof root.classList.contains("dark")).toBe("boolean");
  });
});

describe("window port", () => {
  it("posts to the parent with any origin and only listens to it", () => {
    const posted: unknown[] = [];
    const parent = { postMessage: (message: unknown, origin: string) => posted.push([message, origin]) };
    const port = windowPort(parent, window);
    port.post({ jsonrpc: "2.0", method: "x" });
    expect(posted).toEqual([[{ jsonrpc: "2.0", method: "x" }, "*"]]);

    const received: unknown[] = [];
    const stop = port.listen((m) => received.push(m));
    window.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", method: "a" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", method: "b" }, source: window }));
    stop();
    window.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", method: "c" } }));
    expect(received).toEqual([{ jsonrpc: "2.0", method: "a" }]);
  });
});
