// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CiConnections } from "@/components/agents/settings/CiConnections";

const f = vi.hoisted(() => ({ client: {}, canManageConnections: vi.fn(), connectRepository: vi.fn(), listConnections: vi.fn(), revokeConnection: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => f.client }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u" }, loading: false }) }));
vi.mock("@/lib/agentCi", async (original) => ({ ...await original<object>(), ...f }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); f.canManageConnections.mockResolvedValue(true); f.listConnections.mockResolvedValue([]);
  f.connectRepository.mockResolvedValue({ id: "c", repo: "acme/app", webhook_url: "https://api.test/hook", secret: "abc123" });
  f.revokeConnection.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => root.render(createElement(CiConnections, { workspaceId: "w" }))); };
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
it("keeps repository management hidden from non-owners", async () => {
  f.canManageConnections.mockResolvedValue(false); await mount();
  expect(container.textContent).toBe(""); expect(f.listConnections).not.toHaveBeenCalled();
});
it("connects a repository and lets the owner copy the once-shown command", async () => {
  const copy = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  await mount();
  const input = container.querySelector("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "acme/app"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(f.connectRepository).toHaveBeenCalledWith(f.client, "w", "acme/app");
  expect(container.textContent).toContain("This secret is shown once.");
  await act(async () => button("Copy").click());
  expect(copy).toHaveBeenCalledWith(expect.stringContaining('"config[secret]=abc123"'));
});
it("shows deliveries, disconnects and keeps failed actions visible", async () => {
  f.listConnections.mockResolvedValue([{ id: "c", repo: "acme/app", last_delivery_at: null }, { id: "d", repo: "acme/other", last_delivery_at: "2026-10-30T12:00:00Z" }]);
  await mount(); expect(container.textContent).toContain("Waiting for the first delivery"); expect(container.textContent).toContain("Last delivery");
  f.revokeConnection.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Disconnect").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("offline");
  await act(async () => button("Disconnect").click());
  expect(f.revokeConnection).toHaveBeenLastCalledWith(f.client, "c");
  expect(f.listConnections).toHaveBeenCalledTimes(2);
});
