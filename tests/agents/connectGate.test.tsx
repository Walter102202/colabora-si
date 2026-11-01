// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Home from "@/app/(workspace)/page";
import { useConnectEligibility } from "@/lib/agentConnect";

const f = vi.hoisted(() => ({ rpc: vi.fn(), eq: vi.fn(), load: vi.fn(), backend: true,
  agents: [] as { id: string; is_platform: boolean; revoked_at: string | null }[], status: "ready", userId: "u" }));
const client = { rpc: f.rpc, from: () => ({ select: () => ({ eq: f.eq }) }) };
vi.mock("@/lib/supabase", () => ({ getSupabase: () => f.backend ? client : null }));
vi.mock("@/lib/auth", () => ({ useAuthStore: (selector: (state: object) => unknown) => selector({ user: { id: f.userId } }) }));
vi.mock("@/lib/store", () => ({ useStore: (selector: (state: object) => unknown) => selector({ syncWorkspaceId: "w", pages: {} }) }));
vi.mock("@/lib/agentsStore", () => ({ useAgentsStore: { getState: () => ({ load: f.load, agents: f.agents, status: f.status, workspaceId: "w", userId: "u" }) } }));
vi.mock("@/components/agents/DecisionsHome", () => ({ DecisionsHome: () => null }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); localStorage.clear();
  f.backend = true; f.agents = []; f.status = "ready";
  f.rpc.mockReset().mockResolvedValue({ data: [{ id: "w", name: "Work" }], error: null });
  f.eq.mockReset().mockResolvedValue({ data: [], error: null }); f.load.mockReset().mockResolvedValue(undefined);
  useConnectEligibility.setState({ key: "", gate: "hide", canConnect: false, hasVerified: false });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const mount = (path = "/") => act(async () => root.render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/" element={<Home />} /><Route path="connect" element={<p>Chooser</p>} /></Routes></MemoryRouter>));
it("redirects eligible zero-agent accounts, preserving settings links", async () => {
  await mount(); expect(container.textContent).toBe("Chooser");
});
it("does not redirect a settings link", async () => { await mount("/?settings=agents"); expect(container.textContent).toContain("New database"); });
it.each(["viewer", "offline", "error", "legacy"])("keeps Home available for %s", async (mode) => {
  if (mode === "viewer") f.rpc.mockResolvedValue({ data: [], error: null });
  if (mode === "offline") f.backend = false;
  if (mode === "error") f.eq.mockResolvedValue({ data: null, error: new Error("offline") });
  if (mode === "legacy") f.agents = [{ id: "seed", is_platform: false, revoked_at: null }];
  await mount(); expect(container.textContent).toContain("New database");
});
it("fails open after three seconds and ignores a late result", async () => {
  let finish!: (value: object) => void; f.rpc.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await mount(); expect(container.textContent).toContain("Checking your connections…");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(container.textContent).toContain("New database");
  await act(async () => finish({ data: [{ id: "w" }], error: null })); expect(container.textContent).toContain("New database");
});
it("skip keeps Home with a card and hiding it persists across mounts", async () => {
  useConnectEligibility.setState({ key: "u:w", gate: "show", canConnect: true, hasVerified: false });
  localStorage.setItem("colabora-connect-skipped:w", "true"); await mount();
  expect(container.querySelector('a[href="/connect"]')?.textContent).toBe("Connect an agent");
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Hide this card"]')!.click());
  expect(localStorage.getItem("colabora-connect-card-hidden:w")).toBe("true");
  act(() => root.unmount()); root = createRoot(container); await mount();
  expect(container.querySelector('[aria-label="Hide this card"]')).toBeNull();
});
