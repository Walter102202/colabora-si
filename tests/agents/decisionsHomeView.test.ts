// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionsHomeView } from "@/components/agents/panel";
import type { DecisionsHomeData, HomeItem } from "@/lib/agentHome";

const item = (over: Partial<HomeItem>): HomeItem => ({
  key: "k", section: "waiting", taskId: "t1", rowPageId: "row-1", title: "Task", detail: "Detail", agentName: "Codex",
  href: "/p/row-1?task=t1", at: "2026-10-30T10:00:00Z", nonBlocking: false, stale: false, ...over,
});
const empty: DecisionsHomeData = { waiting: [], working: [], review: [], done: [] };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DecisionsHomeView", () => {
  it("renders four sections with counts, links and empty texts", () => {
    const home: DecisionsHomeData = {
      ...empty,
      waiting: [
        item({ key: "a", title: "Send the summary", detail: "Send an email to team", href: "/p/row-1?task=t1#approval-ap1" }),
        item({ key: "b", title: "Draft the post", detail: "Which tone?", nonBlocking: true }),
      ],
      working: [item({ key: "w", section: "working", detail: "No signals lately", stale: true })],
    };
    act(() => root.render(createElement(DecisionsHomeView, { home })));
    const section = container.querySelector('section[aria-label="Decisions"]');
    expect(section).not.toBeNull();
    expect([...container.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "Waiting for your decision (2)", "Agents working (1)", "Ready for your review (0)", "Done today (0)",
    ]);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/p/row-1?task=t1#approval-ap1");
    expect(container.textContent).toContain("The agent keeps working");
    expect(container.querySelector("[data-stale]")?.textContent).toContain("No signals lately");
    expect(container.textContent).toContain("Nothing to review.");
    expect(container.textContent).toContain("Nothing closed today yet.");
  });
  it("shows a busy placeholder while the tasks load", () => {
    act(() => root.render(createElement(DecisionsHomeView, { home: empty, loading: true })));
    expect(container.querySelector('section[aria-label="Decisions"]')?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll("h2")).toHaveLength(0);
  });
});
