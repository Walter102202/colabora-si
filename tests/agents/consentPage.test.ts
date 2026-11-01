// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConsentPage } from "@/components/agents/ConsentPage";

const f = vi.hoisted(() => ({ client: {} as object | null, user: { id: "u", email: "me@test.local" } as object | null,
  loadConsent: vi.fn(), linkableAgents: vi.fn(), approveConsent: vi.fn(), denyConsent: vi.fn(),
  consentContext: vi.fn(), connectWorkspaces: vi.fn(), connectAgent: vi.fn(), cancelConsent: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => f.client }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: f.user, loading: false }) }));
vi.mock("@/components/AuthModal", () => ({ default: ({ redirectTo }: { redirectTo: string }) => createElement("div", { "data-login": redirectTo }, "Log in") }));
vi.mock("@/lib/agentConsent", async (original) => ({ ...await original<object>(), ...f }));
let root: Root, container: HTMLDivElement;
const context = { clientId: "c", clientName: "Codex", redirectUri: "http://localhost:1455/callback", redirectHost: "http://localhost:1455/callback", redirectIsApp: false };
const detail = { ...context, kind: "ask", authorizationId: "a", email: "me@test.local" };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  f.client = {}; f.user = { id: "u", email: "me@test.local" }; vi.clearAllMocks();
  f.consentContext.mockReset().mockResolvedValue(context);
  f.connectWorkspaces.mockReset().mockResolvedValue([{ id: "w", name: "My Workspace" }]);
  f.linkableAgents.mockReset().mockResolvedValue([]);
  f.loadConsent.mockReset().mockResolvedValue(detail);
  f.connectAgent.mockReset().mockResolvedValue("http://localhost:1455/callback?code=test");
  f.cancelConsent.mockReset().mockResolvedValue("http://localhost:1455/callback?error=access_denied");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const mount = (path = "/oauth/consent?authorization_id=a") => act(async () => root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(ConsentPage))));
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
const select = (label: string) => [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label))!.querySelector("select")!;
it("rejects incomplete links and keeps consent URL for sign-in", async () => {
  await mount("/oauth/consent"); expect(container.textContent).toContain("This link is incomplete"); expect(f.consentContext).not.toHaveBeenCalled();
});
it("keeps the consent URL for login", async () => {
  f.user = null; await mount(); expect(container.querySelector("[data-login]")?.getAttribute("data-login")).toBe(window.location.href);
});
it("defaults to new agent, displays the complete return address and never offers As you locally", async () => {
  await mount(); expect(container.querySelector("input")?.value).toBe("Codex"); expect(select("Role").value).toBe("worker");
  expect(container.textContent).toContain(context.redirectUri); expect(container.textContent).toContain("This name was supplied by the app.");
  expect(container.textContent).not.toContain("As you"); expect(f.loadConsent).not.toHaveBeenCalled(); expect(f.connectAgent).not.toHaveBeenCalled();
});
it("matches an existing agent without changing its role and allows creating a new one", async () => {
  f.linkableAgents.mockResolvedValue([{ id: "agent", name: "CODEX", workspace_id: "w", role: "lead" }]); await mount();
  expect(select("Agent").value).toBe("agent"); expect(container.textContent).not.toContain("Role");
  expect(container.textContent).toContain("Adds Getting started to what this agent can already reach.");
  await act(async () => { const node = select("Agent"); node.value = "new"; node.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(select("Role").value).toBe("worker");
});
it("connects a lead once across rapid clicks", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  let finish!: (value: string) => void; f.connectAgent.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await mount(); act(() => { const node = select("Role"); node.value = "lead"; node.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { button("Connect Codex").click(); button("Connect Codex").click(); });
  expect(f.connectAgent).toHaveBeenCalledTimes(1);
  expect(f.connectAgent).toHaveBeenCalledWith(f.client, { authorizationId: "a", workspaceId: "w", name: "Codex", role: "lead" });
  await act(async () => finish("http://localhost:1455/callback")); expect(navigate).toHaveBeenCalledTimes(1);
});
it("cancel creates nothing and returns to the requesting app", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {}); await mount();
  await act(async () => button("Cancel").click()); expect(f.cancelConsent).toHaveBeenCalledWith(f.client, "a", "c");
  expect(f.connectAgent).not.toHaveBeenCalled(); expect(navigate).toHaveBeenCalledTimes(1);
});
it("recovers from saving errors and blocks unsafe redirects", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  f.connectAgent.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("javascript:alert(1)"); await mount();
  await act(async () => button("Connect Codex").click()); expect(container.textContent).toContain("We couldn’t finish saving this connection.");
  await act(async () => button("Try again").click()); expect(navigate).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
it("keeps the trusted human flow at two steps and preserves it on an auth refresh", async () => {
  f.consentContext.mockResolvedValue({ ...context, redirectUri: "https://claude.ai/cb", redirectHost: "https://claude.ai" });
  f.loadConsent.mockResolvedValue({ ...detail, redirectUri: "https://claude.ai/cb" });
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  f.approveConsent.mockResolvedValue("https://claude.ai/cb"); await mount();
  act(() => container.querySelector<HTMLInputElement>('input[value="human"]')!.click());
  f.user = { id: "u", email: "me@test.local" }; await mount(); expect(f.consentContext).toHaveBeenCalledTimes(1);
  await act(async () => button("Continue").click()); expect(f.loadConsent).toHaveBeenCalledWith(f.client, "a", null);
  await act(async () => button("Approve").click()); expect(navigate).toHaveBeenCalledWith("https://claude.ai/cb"); expect(f.connectAgent).not.toHaveBeenCalled();
});
it("shows no-workspace state for a local app", async () => {
  f.connectWorkspaces.mockResolvedValue([]); await mount(); expect(container.textContent).toContain("You don’t have a workspace you can connect here.");
  expect(container.querySelector('a[href="/"]')).not.toBeNull();
});
it("refuses iframe operation", async () => {
  vi.spyOn(window, "top", "get").mockReturnValue({} as Window); await mount(); expect(container.querySelector("button")).toBeNull(); expect(f.consentContext).not.toHaveBeenCalled();
});
it("reports expired authorization and backend unavailability", async () => {
  f.consentContext.mockRejectedValue(new Error("expired")); await mount(); expect(container.textContent).toContain("This approval link has expired.");
});
it("reports an unavailable backend", async () => { f.client = null; await mount(); expect(container.textContent).toContain("Sign-in is not available here."); });
it.each(["https://claude.ai/cb", "data:text/html,test"])("preserves pending remembered consent across an auth refresh and validates %s", async (url) => {
  f.consentContext.mockResolvedValue({ ...context, redirectUri: "https://claude.ai/cb" });
  let finish!: (value: unknown) => void;
  f.loadConsent.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  await mount(); act(() => container.querySelector<HTMLInputElement>('input[value="human"]')!.click());
  await act(async () => button("Continue").click());
  f.user = { id: "u" }; await mount();
  await act(async () => finish({ kind: "redirect", url }));
  expect(f.loadConsent).toHaveBeenCalledTimes(1);
  if (url.startsWith("https:")) expect(navigate).toHaveBeenCalledExactlyOnceWith(url);
  else { expect(navigate).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull(); }
});
