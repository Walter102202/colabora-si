// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectAgent } from "@/components/agents/connect/ConnectAgent";

const f = vi.hoisted(() => ({ load: vi.fn(), copy: vi.fn(), invoke: vi.fn(), token: vi.fn(), user: { id: "u" } as object | null }));
const client = { functions: { invoke: f.invoke } };
vi.mock("@/lib/supabase", () => ({ isSupabaseConfigured: () => true, getSupabase: () => client }));
vi.mock("@/lib/auth", () => ({ useAuthStore: (selector: (state: object) => unknown) => selector({ user: f.user }) }));
vi.mock("@/lib/store", () => ({ useStore: (selector: (state: object) => unknown) => selector({ syncWorkspaceId: "w" }) }));
vi.mock("@/lib/agentsStore", () => ({ mcpUrls: () => ({ mcpUrl: "https://example.test/functions/v1/mcp", tokenUrl: "https://example.test/functions/v1/agent-token" }), useAgentsStore: { getState: () => ({ issueToken: f.token }) } }));
vi.mock("@/lib/agentConnect", async (original) => ({ ...await original<object>(), loadConnections: f.load }));
let root: Root, container: HTMLDivElement;
const row = { agent_id: "a", page_id: "p", approved_at: "2026-11-01T10:00:00Z", verified_at: null, created_at: "2026-11-01T10:00:00Z" };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T10:00:00Z")); sessionStorage.clear(); f.user = { id: "u" };
  f.load.mockReset().mockResolvedValue([]); f.copy.mockReset().mockResolvedValue(undefined);
  f.invoke.mockReset().mockResolvedValue({ data: { agent_id: "a", page_id: "p" }, error: null }); f.token.mockReset().mockResolvedValue("agt_test_secret");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: f.copy } });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const mount = (slug = "codex") => act(async () => root.render(<MemoryRouter initialEntries={[`/connect/${slug}`]}><Routes><Route path="connect/:agent" element={<ConnectAgent />} /></Routes></MemoryRouter>));
const button = (label: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
it("resumes an attempt, distinguishes approval from a read, and stops polling after connection", async () => {
  sessionStorage.setItem("colabora-connect-attempt", JSON.stringify({ agent: "codex", startedAt: Date.now() })); f.load.mockResolvedValue([row]);
  await mount(); expect(container.textContent).toContain("Access approved"); expect(container.textContent).not.toContain("Codex is connected");
  f.load.mockResolvedValue([{ ...row, verified_at: row.approved_at }]); await advance(3000);
  expect(container.textContent).toContain("Codex is connected"); const count = f.load.mock.calls.length;
  await advance(9000); expect(f.load).toHaveBeenCalledTimes(count);
  expect(container.querySelector('a[href="/p/p"]')).not.toBeNull();
});
it("does not poll hidden tabs and checks when visible again", async () => {
  await mount(); await act(async () => button("Copy setup message").click()); const count = f.load.mock.calls.length;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); await advance(9000); expect(f.load).toHaveBeenCalledTimes(count);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(f.load).toHaveBeenCalledTimes(count + 1);
  await advance(60_000); expect(container.textContent).toContain("Still waiting. Your agent may need you to finish setup.");
  expect(container.textContent).toContain("Nothing happened?");
});
it.each(["cursor", "chatgpt", "antigravity"])("%s approval offers the first task to trigger a real read", async (slug) => {
  sessionStorage.setItem("colabora-connect-attempt", JSON.stringify({ agent: slug, startedAt: Date.now() })); f.load.mockResolvedValue([row]);
  await mount(slug); expect(container.textContent).toContain("We’ll confirm the connection when it reads your page.");
  await act(async () => button("Copy first task").click()); expect(f.copy.mock.calls[0][0]).toContain("Read “Getting started”");
});
it("creates one own agent, issues its token and never persists the secret", async () => {
  await mount("your-agent");
  act(() => { const input = container.querySelector("input")!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Worker"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { button("Create agent token").click(); button("Create agent token").click(); });
  expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.token).toHaveBeenCalledWith("a", "default");
  expect(container.textContent).toContain("This token appears only once."); expect(container.textContent).toContain("agt_test_secret");
  expect(sessionStorage.getItem("colabora-connect-attempt")).toContain('"agentId":"a"');
  expect(JSON.stringify({ ...sessionStorage })).not.toContain("agt_test_secret");
  await act(async () => button("Copy settings").click()); expect(f.copy.mock.calls[0][0]).toContain("WORKSPACE_AGENT_PAT=agt_test_secret");
});
it("signed-out setup does not query live connection state", async () => {
  f.user = null; await mount(); await act(async () => button("Copy setup message").click()); await advance(9000); expect(f.load).not.toHaveBeenCalled();
});
