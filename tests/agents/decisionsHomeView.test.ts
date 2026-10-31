// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionsHomeView } from "@/components/agents/panel";
import type { DecisionsHomeData, HomeItem } from "@/lib/agentHome";
import type { ApprovalRow } from "@/lib/agentTasks";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";

const approvals = () => ["one", "two", "three"].map((id) => ({ ...(mockCard("approval") as TaskCardData).approval!, id, task_id: "t1", kind: "action", status: "pending", question: `Action ${id}`, options: ["approve", "reject"] } as ApprovalRow));

it("decides selected approvals once each and keeps a failed row visible while continuing", async () => {
  const { ApprovalGroupCard } = await import("@/components/agents/panel/ApprovalGroupCard");
  const rows = approvals();
  const onDecide = vi.fn(async (id: string) => { if (id === "one") throw new Error("Still pending"); });
  await act(async () => root.render(createElement(ApprovalGroupCard, { approvals: rows, onDecide })));
  expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((c) => !c.checked)).toBe(true);
  act(() => { (container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]).click(); (container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2]).click(); });
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Approve selected")!.click());
  expect(onDecide.mock.calls.map((c) => c[0])).toEqual(["one", "three"]);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Still pending");
  await act(async () => root.render(createElement(ApprovalGroupCard, { approvals: [rows[0]], onDecide })));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Still pending");
});

it("uses the existing approval card for one item and groups actions by task on Home", async () => {
  const { ApprovalGroupCard } = await import("@/components/agents/panel/ApprovalGroupCard");
  const rows = approvals().slice(0, 2);
  const onDecide = vi.fn(async () => {});
  await act(async () => root.render(createElement(ApprovalGroupCard, { approvals: [rows[0]], onDecide })));
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Approve")).toBe(true);
  const home = { ...empty, waiting: rows.map((a) => item({ key: `approval:${a.id}` })) };
  await act(async () => root.render(createElement(DecisionsHomeView, { home, approvals: rows, onDecide })));
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Reject selected")!.click());
  expect(onDecide).toHaveBeenCalledExactlyOnceWith("one", "reject", null);
});

it("never carries edited parameters from one singleton approval into the next", async () => {
  const { ApprovalGroupCard } = await import("@/components/agents/panel/ApprovalGroupCard");
  const rows = approvals().slice(0, 2).map((approval, i) => ({ ...approval, options: ["approve", "edit", "reject"] as ApprovalRow["options"], params: { target: `target-${i}` } }));
  const onDecide = vi.fn(async () => {});
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
  await act(async () => root.render(createElement(ApprovalGroupCard, { approvals: [rows[0]], onDecide })));
  act(() => button("Edit").click());
  const box = container.querySelector("textarea")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, '{"target":"edited-old"}'); box.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => root.render(createElement(ApprovalGroupCard, { approvals: [rows[1]], onDecide })));
  expect(container.querySelector("textarea")).toBeNull();
  act(() => button("Edit").click());
  expect(JSON.parse(container.querySelector("textarea")!.value)).toEqual(rows[1].params);
  await act(async () => button("Approve with these changes").click());
  expect(onDecide).toHaveBeenCalledExactlyOnceWith("two", "edit", { params: rows[1].params });
});

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
  it("says the decisions could not load, with a retry, instead of empty sections", () => {
    const onRetry = vi.fn();
    act(() => root.render(createElement(DecisionsHomeView, { home: empty, error: "Failed to fetch", onRetry })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not load decisions: Failed to fetch");
    expect(container.querySelectorAll("h2")).toHaveLength(0);
    expect(container.textContent).not.toContain("Nothing waits for your decision.");
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it("offers no retry button without a retry callback", () => {
    act(() => root.render(createElement(DecisionsHomeView, { home: empty, error: "Failed to fetch" })));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});
