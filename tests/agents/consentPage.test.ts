// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConsentPage } from "@/components/agents/ConsentPage";

const f = vi.hoisted(() => ({ client: {} as object | null, user: { id: "u" } as object | null,
  loadConsent: vi.fn(), linkableAgents: vi.fn(), approveConsent: vi.fn(), denyConsent: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => f.client }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: f.user, loading: false }) }));
vi.mock("@/components/AuthModal", () => ({ default: ({ redirectTo }: { redirectTo: string }) => createElement("div", { "data-login": redirectTo }, "Log in") }));
vi.mock("@/lib/agentConsent", async (original) => ({ ...await original<object>(), ...f }));
let root: Root, container: HTMLDivElement;
const detail = { kind: "ask", authorizationId: "a", clientId: "c", clientName: "Claude", redirectHost: "real.test", email: "me@test.local" };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  f.client = {}; f.user = { id: "u" }; vi.clearAllMocks();
  f.loadConsent.mockReset().mockResolvedValue(detail); f.linkableAgents.mockReset().mockResolvedValue([{ id: "agent", name: "Worker" }]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const mount = async (path = "/oauth/consent?authorization_id=a") => {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(ConsentPage))));
};
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
it("rejects incomplete links and asks signed-out people to log in", async () => {
  await mount("/oauth/consent"); expect(container.textContent).toContain("This link is incomplete");
  expect(f.loadConsent).not.toHaveBeenCalled();
});
it("keeps the consent URL for login", async () => {
  f.user = null; await mount(); expect(container.textContent).toContain("Log in");
  expect(container.querySelector("[data-login]")?.getAttribute("data-login")).toBe(window.location.href);
});
it("shows the actual host and unverified-name warning, defaulting to the agent", async () => {
  await mount(); expect(container.textContent).toContain("Claude wants to connect to colabora.si");
  expect(container.textContent).toContain("After you approve, you return to real.test.");
  expect(container.textContent).toContain("The app wrote this name itself.");
  expect(container.querySelector<HTMLInputElement>('input[value="agent"]')?.checked).toBe(true);
  expect(container.querySelector("select")?.value).toBe("agent");
});
it("offers only As you when there are no linkable agents", async () => {
  f.linkableAgents.mockResolvedValue([]); await mount();
  expect(container.textContent).not.toContain("As an agent");
  expect(container.querySelector<HTMLInputElement>('input[value="human"]')?.checked).toBe(true);
});
it("approves the selected agent then navigates to the returned URL", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  f.approveConsent.mockResolvedValue("https://real.test/cb"); await mount();
  await act(async () => button("Approve").click());
  expect(f.approveConsent).toHaveBeenCalledWith(f.client, "a", "c", "agent");
  expect(navigate).toHaveBeenCalledWith("https://real.test/cb");
});
it("blocks unsafe redirects on both automatic and approved responses", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  f.approveConsent.mockResolvedValue("javascript:alert(1)"); await mount();
  await act(async () => button("Approve").click());
  expect(navigate).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
it("handles an automatic redirect through the same safety check", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  f.loadConsent.mockResolvedValue({ kind: "redirect", url: "data:text/html,test" }); await mount();
  expect(navigate).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
it("refuses to run in an iframe", async () => {
  vi.spyOn(window, "top", "get").mockReturnValue({} as Window); await mount();
  expect(container.querySelector("button")).toBeNull(); expect(f.loadConsent).not.toHaveBeenCalled();
});
it("reports expired requests and an unavailable backend", async () => {
  f.loadConsent.mockRejectedValue(new Error("expired")); await mount();
  expect(container.textContent).toContain("This request expired");
});
it("reports an unavailable backend", async () => {
  f.client = null; await mount(); expect(container.textContent).toContain("Sign-in is not available here.");
});

it("keeps a remembered-consent redirect when Auth refreshes the same user during the read", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  let finish!: (value: unknown) => void;
  f.loadConsent.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockRejectedValueOnce(new Error("authorization already consumed"));
  await mount(); f.user = { id: "u" }; await mount();
  await act(async () => finish({ kind: "redirect", url: "https://real.test/cb" }));
  expect(f.loadConsent).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledExactlyOnceWith("https://real.test/cb");
});
it.each(["agent", "human"])("returning to the tab preserves the %s choice without rereading", async (mode) => {
  f.linkableAgents.mockResolvedValue([{ id: "agent", name: "Worker" }, { id: "reviewer", name: "Reviewer" }]);
  await mount();
  act(() => {
    const select = container.querySelector("select")!; select.value = "reviewer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    container.querySelector<HTMLInputElement>(`input[value="${mode}"]`)!.click();
  });
  f.user = { id: "u" }; await mount();
  expect(f.loadConsent).toHaveBeenCalledTimes(1);
  expect(container.querySelector("select")?.value).toBe("reviewer");
  expect(container.querySelector<HTMLInputElement>(`input[value="${mode}"]`)?.checked).toBe(true);
});
