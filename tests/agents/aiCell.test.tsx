// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiCell } from "@/components/agents/AiCell";
import { useStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth";
import { useAgentsStore, type AgentRow } from "@/lib/agentsStore";
import { db, page, prop, row } from "../clone/fixtures";

const mocked = vi.hoisted(() => ({ fill: vi.fn(), requests: [] as Record<string, unknown>[] }));
vi.mock("@/lib/agentAiRequests", async (original) => ({
  ...(await original<typeof import("@/lib/agentAiRequests")>()),
  requestAiFill: mocked.fill, useAiRequests: () => mocked.requests,
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => ({}) }));
let container: HTMLDivElement, root: Root;
const property = prop({ id: "summary", name: "Summary", type: "ai", aiPrompt: "Summarize" });
const database = db([property]);
const theRow = row({}, "row-page");
const cell = { text: "Short", by: "agent", id: "agent-user", at: 1, agentId: "a1", runId: "r", taskId: "t" };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocked.fill.mockReset().mockResolvedValue({ taskId: "t", rows: 1, remaining: 0 }); mocked.requests = [];
  useStore.setState({ pages: { "db-page": page({ id: "db-page", database }), "row-page": page({ id: "row-page", parentId: "db-page" }) } });
  useAuthStore.setState({ user: { id: "person" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>, loading: false });
  useAgentsStore.setState({ agents: [{ id: "a1", name: "Colabora" } as AgentRow] });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(value: unknown = null, onChange = vi.fn()) {
  act(() => root.render(<AiCell row={{ ...theRow, cells: { summary: value } }} property={property} database={database} readOnly={false} onChange={onChange} />));
  return onChange;
}
it("shows the agent's text with its signature", () => {
  render(cell);
  expect(container.textContent).toContain("Short");
  expect(container.querySelector('[aria-label="Filled by Colabora"]')?.getAttribute("href")).toBe("/p/db-page?task=t");
});
it("an empty cell offers Generate", async () => {
  render();
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  expect(mocked.fill).toHaveBeenCalledWith("db-page", "summary", "empty", [theRow.id]);
});
it("a row in an open fill shows Generating", () => {
  mocked.requests = [{ kind: "fill", state: "working", request: { property_id: "summary", row_ids: [theRow.id] } }];
  render();
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Generating…");
});
it("an error shows with Retry", () => {
  render({ ...cell, text: "", error: "No answer" });
  expect(container.textContent).toContain("No answer");
  expect(container.querySelector("button")?.textContent).toBe("Retry");
});
it("a person's edit is stored as a human value", () => {
  const onChange = render(cell);
  const input = container.querySelector("textarea")!;
  act(() => { input.value = "Mine"; input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(onChange).toHaveBeenCalledWith({ text: "Mine", by: "human", id: "person", at: expect.any(Number) });
});
it("a second fill shows that one is already running", async () => {
  mocked.fill.mockRejectedValue(new Error("request_in_progress"));
  render();
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  expect(container.textContent).toContain("A fill is already running");
});
