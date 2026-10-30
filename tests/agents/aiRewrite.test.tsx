// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import InlineToolbar from "@/components/InlineToolbar";
import { AiRewritePanel } from "@/components/agents/AiRewritePanel";
import { AiRequestToasts } from "@/components/agents/AiRequestToasts";

const mocked = vi.hoisted(() => ({ backend: true, client: null as unknown, rewrite: vi.fn(), revert: vi.fn(), cancel: vi.fn(), requests: [] as Record<string, unknown>[] }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => mocked.backend ? mocked.client ?? {} : null }));
vi.mock("@/lib/agentAiRequests", async (original) => ({ ...(await original<typeof import("@/lib/agentAiRequests")>()),
  requestAiRewrite: mocked.rewrite, useAiRequests: () => mocked.requests }));
vi.mock("@/lib/agentActions", () => ({ revertRun: mocked.revert, sendMessage: mocked.cancel }));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocked.backend = true; mocked.client = null; mocked.requests = []; mocked.rewrite.mockReset().mockResolvedValue({ taskId: "t" }); mocked.revert.mockReset().mockResolvedValue({ reverted: [] });
  mocked.cancel.mockReset().mockResolvedValue({ delivery: "stop_requested" });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it("the toolbar shows AI only with a backend and a target", () => {
  const range = document.createRange(); range.selectNodeContents(container);
  const draw = (target?: { pageId: string; blockId: string }, locked = false) => act(() => root.render(
    <InlineToolbar range={range} rect={new DOMRect()} aiTarget={target} locked={locked} onChange={() => {}} onClose={() => {}} />));
  draw(); expect(container.querySelector('[aria-label="Rewrite with AI"]')).toBeNull();
  draw({ pageId: "p", blockId: "b" }); expect(container.querySelector('[aria-label="Rewrite with AI"]')).not.toBeNull();
  draw({ pageId: "p", blockId: "b" }, true); expect(container.querySelector('[aria-label="Rewrite with AI"]')).toBeNull();
  mocked.backend = false; draw({ pageId: "p", blockId: "b" }); expect(container.querySelector('[aria-label="Rewrite with AI"]')).toBeNull();
});
const panel = () => act(() => root.render(<AiRewritePanel pageId="p" blockId="b" selectionText="selected" onDone={() => {}} />));
it("a preset sends its instruction", async () => {
  panel();
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Shorter")!.click());
  expect(mocked.rewrite).toHaveBeenCalledWith("p", "b", "Make it shorter", "selected");
});
it("a custom instruction is sent on Enter", async () => {
  panel(); const input = container.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Use plain English");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(mocked.rewrite).toHaveBeenCalledWith("p", "b", "Use plain English", "selected");
});
it("the toast says Rewriting, then offers Undo", async () => {
  mocked.requests = [{ id: "t", kind: "rewrite", state: "working", request: { block_id: "b" } }];
  act(() => root.render(<AiRequestToasts pageId="p" />));
  expect(container.textContent).toContain("Colabora is rewriting…");
  mocked.requests = [{ ...mocked.requests[0], state: "done", runId: "r", closedAt: new Date().toISOString() }];
  act(() => root.render(<AiRequestToasts pageId="p" />));
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Undo")!.click());
  expect(mocked.revert).toHaveBeenCalledWith("t", "r", ["block:p:b"]);
});
it.each(["fill", "rewrite"])("offers cancellation for queued and working %s requests", async (kind) => {
  mocked.requests = ["queued", "working"].map((state) => ({ id: state, kind, state, request: {} }));
  act(() => root.render(<AiRequestToasts pageId="p" />));
  const buttons = [...container.querySelectorAll("button")].filter(b => b.textContent === "Cancel");
  expect(buttons).toHaveLength(2);
  for (const button of buttons) await act(async () => button.click());
  expect(mocked.cancel.mock.calls).toEqual([["queued", "Cancel AI request", "stop"], ["working", "Cancel AI request", "stop"]]);
});
it("errors are readable", async () => {
  mocked.rewrite.mockRejectedValue(new Error("block_has_mentions")); panel();
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Shorter")!.click());
  expect(container.textContent).toContain("This block has mentions or equations, which AI rewrite keeps out of reach.");
});
it("loads a recently failed request even when end_run left closed_at null", async () => {
  const row: Record<string, unknown> = { id: "failed", request_kind: "rewrite", state: "failed", request: { block_id: "b" }, closed_at: null, active_run_id: null, updated_at: new Date().toISOString() };
  const channel = { on: () => channel, subscribe: () => channel };
  mocked.client = {
    channel: () => channel, removeChannel: async () => {},
    from: (table: string) => {
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      const query = {
        select: () => query, eq: () => query, not: () => query, order: () => query, limit: () => query,
        in: (key: string, values: unknown[]) => { filters.push((r) => values.includes(r[key])); return query; },
        gte: (key: string, value: string) => { filters.push((r) => typeof r[key] === "string" && r[key] >= value); return query; },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === "agent_tasks" ? [row].filter((r) => filters.every((f) => f(r))) : [], error: null }).then(resolve),
      };
      return query;
    },
  };
  const actual = await vi.importActual<typeof import("@/lib/agentAiRequests")>("@/lib/agentAiRequests");
  function Probe() { return <span>{actual.useAiRequests("p").map((r) => r.state).join(",")}</span>; }
  await act(async () => { root.render(<Probe />); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(container.textContent).toBe("failed");
});
