// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectAgent } from "@/components/agents/connect/ConnectAgent";
import Shell from "@/components/Shell";

const f = vi.hoisted(() => ({ configured: true, copy: vi.fn(), tramaMounts: 0 }));
vi.mock("@/lib/supabase", () => ({ isSupabaseConfigured: () => f.configured, getSupabase: () => null }));
vi.mock("@/lib/agentsStore", () => ({ mcpUrls: () => ({ mcpUrl: "https://example.test/functions/v1/mcp" }) }));
vi.mock("@/lib/store", () => ({ useStore: (selector: (state: object) => unknown) => selector({ syncWorkspaceId: "w", pages: {} }), getBreadcrumb: () => [] }));
vi.mock("@/lib/auth", () => ({ initAuth: () => {}, useAuthStore: Object.assign((selector: (state: object) => unknown) => selector({ user: null }), { getState: () => ({ user: null }), subscribe: () => () => {} }) }));
vi.mock("@/lib/sync", () => ({ initSync: () => {}, stopSync: () => {} }));
vi.mock("@/lib/history", () => ({ initHistory: () => {}, undo: () => {}, redo: () => {} }));
vi.mock("@/lib/notifications", () => ({ initNotifications: () => {}, stopNotifications: () => {} }));
vi.mock("@/lib/directory", () => ({ useWorkspaceDirectory: () => {} }));
vi.mock("@/lib/presence", () => ({ usePresenceSession: () => {}, useSharedPresenceScope: () => undefined }));
vi.mock("@/components/Sidebar", () => ({ default: () => <aside>Sidebar</aside> }));
vi.mock("@/components/PresenceAvatars", () => ({ default: () => null }));
vi.mock("@/components/agents/PresenceBadge", () => ({ PresenceBadge: () => null }));
vi.mock("@/components/HumanNotifications", () => ({ default: () => null }));
vi.mock("@/components/ReminderBell", () => ({ default: () => null }));
vi.mock("@/components/SyncConflictModal", () => ({ default: () => null }));
vi.mock("@/components/agents/InboxBell", () => ({ InboxBell: () => { useEffect(() => { f.tramaMounts++; }, []); return <span>Trama</span>; } }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  f.configured = true; f.tramaMounts = 0; f.copy.mockReset().mockResolvedValue(undefined); sessionStorage.clear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: f.copy } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const mount = (path = "/connect") => act(async () => root.render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="connect" element={<ConnectAgent />} /><Route path="connect/:agent" element={<ConnectAgent />} />
  <Route path="/" element={<p>Home</p>} />
</Routes></MemoryRouter>));
const button = (name: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === name)!;
it("offers eleven accessible choices, decorative logos and the notice", async () => {
  await mount();
  expect(container.querySelectorAll('button[aria-label^="Connect with "]')).toHaveLength(11);
  expect(container.querySelectorAll('img[alt=""]')).toHaveLength(10);
  expect(container.textContent).toContain("Product names and logos belong to their respective owners.");
  expect(container.textContent).toContain("Which agent do you use?");
});
it("chooses one setup action, copies exactly the visible message and changes back", async () => {
  await mount(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Connect with Claude Code"]')!.click());
  const message = container.querySelector("pre")!.textContent;
  expect(container.querySelectorAll('button[data-setup-action]')).toHaveLength(1);
  await act(async () => button("Copy setup message").click());
  expect(f.copy).toHaveBeenCalledExactlyOnceWith(message);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Copied — paste into Claude Code");
  await act(async () => button("Change agent").click());
  expect(container.querySelectorAll('button[aria-label^="Connect with "]')).toHaveLength(11);
});
it("handles clipboard denial and deep links without requiring a session", async () => {
  f.copy.mockRejectedValue(new Error("denied")); await mount("/connect/codex");
  await act(async () => button("Copy setup message").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Select it below and copy it yourself.");
});
it("unknown IDs show the chooser and skipping stores the workspace choice", async () => {
  await mount("/connect/unknown"); expect(container.textContent).toContain("Which agent do you use?");
  await act(async () => button("Skip for now").click());
  expect(localStorage.getItem("colabora-connect-skipped:w")).toBe("true");
  expect(container.textContent).toBe("Home");
});
it("shows the cloud requirement without a backend", async () => {
  f.configured = false; await mount(); expect(container.textContent).toContain("Agents need the cloud.");
});
it("keeps the top-bar Trama mount across setup navigation and lets the sidebar open", async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={["/connect"]}><Routes><Route element={<Shell><Outlet /></Shell>}>
    <Route path="connect" element={<ConnectAgent />} /><Route path="connect/:agent" element={<ConnectAgent />} />
  </Route></Routes></MemoryRouter>));
  expect(container.querySelector("header")?.textContent).toContain("Trama");
  expect(container.querySelector<HTMLElement>(".app-sidebar")?.style.width).toBe("0px");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open sidebar"]')!.click());
  expect(container.querySelector<HTMLElement>(".app-sidebar")?.style.width).toBe("260px");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Connect with Codex"]')!.click());
  expect(f.tramaMounts).toBe(1);
  expect(container.querySelector("header")?.textContent).toContain("Trama");
});
