// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectedAgents } from "@/components/agents/connect/ConnectedAgents";
import { connectedRows, type ConnectionRow } from "@/lib/agentConnect";
import type { AutonomyLevel } from "@/lib/agentAutonomy";
import type { AgentRole } from "@/lib/agentsStore";

const f = vi.hoisted(() => ({ rpc: vi.fn(), eq: vi.fn(), load: vi.fn(), policy: vi.fn(), workspace: vi.fn(), role: vi.fn(), autonomy: vi.fn(), backend: true, workspaceId: "w", userId: "u", status: "ready",
  agents: [] as { id: string; name: string; is_platform: boolean; revoked_at: string | null; role: AgentRole; autonomy: AutonomyLevel | null }[] }));
const client = { rpc: f.rpc, from: () => ({ select: () => ({ eq: f.eq }) }) };
vi.mock("@/lib/supabase", () => ({ getSupabase: () => f.backend ? client : null }));
vi.mock("@/lib/auth", () => ({ useAuthStore: (selector: (state: object) => unknown) => selector({ user: { id: "u" } }) }));
vi.mock("@/lib/store", () => ({ useStore: (selector: (state: object) => unknown) => selector({ syncWorkspaceId: f.workspaceId, pages: { p: { title: "Getting started" } } }) }));
vi.mock("@/lib/agentsStore", () => ({ useAgentsStore: { getState: () => ({ load: f.load, agents: f.agents, status: f.status, workspaceId: "w", userId: f.userId, setAgentRole: f.role, setAgentAutonomy: f.autonomy }) } }));
vi.mock("@/lib/agentActions", () => ({ getAutonomyPolicy: f.policy, setWorkspaceAutonomy: f.workspace }));

const agent = (id = "a", name = "Codex") => ({ id, name, is_platform: false, revoked_at: null, role: "worker" as const, autonomy: null });
const connection = (agentId = "a", verified: string | null = null): ConnectionRow => ({ agent_id: agentId, page_id: "p", approved_at: "2026-11-01T10:00:00Z", verified_at: verified, created_at: "2026-11-01T10:00:00Z" });
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); f.backend = true; f.agents = []; f.status = "ready"; f.workspaceId = "w"; f.userId = "u";
  f.rpc.mockReset().mockResolvedValue({ data: [{ id: "w", name: "Work" }], error: null });
  f.eq.mockReset().mockResolvedValue({ data: [], error: null }); f.load.mockReset().mockResolvedValue(undefined);
  f.policy.mockReset().mockResolvedValue({ level: "balanced", can_edit: true });
  f.workspace.mockReset().mockResolvedValue({ level: "ask", previous: "balanced" });
  f.role.mockReset().mockResolvedValue(undefined); f.autonomy.mockReset().mockResolvedValue(undefined);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const mount = () => act(async () => root.render(<ConnectedAgents />));
const advance = () => act(async () => { await vi.advanceTimersByTimeAsync(5000); });

it("maps states, dates, logos and starter pages; sorts recent connections before manual agents", () => {
  const agents = [agent("manual", "Custom"), agent("waiting", "codex"), agent("read", "Claude Code"),
    { ...agent("trama", "Trama"), is_platform: true }, { ...agent("revoked"), revoked_at: "2026-11-01" }];
  expect(connectedRows(agents, [connection("waiting"), connection("read", "2026-11-02T10:00:00Z"), connection("trama"), connection("revoked")])).toEqual([
    { agentId: "read", name: "Claude Code", status: "connected", since: "2026-11-02T10:00:00Z", pageId: "p", logo: "/brand/agents/claude-code.svg", role: "worker", autonomy: null },
    { agentId: "waiting", name: "codex", status: "waiting", since: "2026-11-01T10:00:00Z", pageId: "p", logo: "/brand/agents/codex.svg", role: "worker", autonomy: null },
    { agentId: "manual", name: "Custom", status: "manual", since: null, pageId: null, logo: null, role: "worker", autonomy: null },
  ]);
});
it("shows an empty list, then a new connection and its first read without a reload", async () => {
  await mount(); expect(container.textContent).toContain("No agents connected yet.");
  expect(container.querySelector('a[href="/connect"]')?.textContent).toBe("Connect an agent");
  f.agents = [agent()]; f.eq.mockResolvedValue({ data: [connection()], error: null }); await advance();
  expect(container.textContent).toContain("Codex"); expect(container.textContent).toContain("Waiting for first read");
  expect(container.querySelector('a[href="/p/p"]')?.textContent).toBe("Open Getting started");
  f.eq.mockResolvedValue({ data: [connection("a", "2026-11-02T10:00:00Z")], error: null }); await advance();
  expect(container.textContent).not.toContain("Waiting for first read"); expect(container.querySelector("time")?.dateTime).toBe("2026-11-02T10:00:00Z");
  expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
  f.agents = [{ ...agent(), revoked_at: "2026-11-03" }]; await advance();
  expect(container.textContent).not.toContain("Codex"); expect(container.textContent).toContain("No agents connected yet.");
});
it("allows a viewer to read the list without the connect button and hides missing starter pages", async () => {
  f.rpc.mockResolvedValue({ data: [], error: null }); f.agents = [agent(), agent("manual", "Custom")];
  f.eq.mockResolvedValue({ data: [{ ...connection(), page_id: "missing" }], error: null }); await mount();
  expect(container.textContent).toContain("Codex"); expect(container.textContent).toContain("Added in Settings");
  expect(container.querySelector('a[href="/connect"]')).toBeNull(); expect(container.querySelector('a[href="/p/missing"]')).toBeNull();
  expect(container.querySelector('a[href="/?settings=agents"]')?.textContent).toBe("Manage access");
});
it("does not query hidden tabs, refreshes on return and stops on unmount", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); await mount(); await advance();
  expect(f.load).not.toHaveBeenCalled(); expect(f.eq).not.toHaveBeenCalled();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(f.load).toHaveBeenCalledWith("w"); expect(f.eq).toHaveBeenCalledTimes(1);
  act(() => root.unmount()); root = createRoot(container); await advance();
  document.dispatchEvent(new Event("visibilitychange")); expect(f.eq).toHaveBeenCalledTimes(1);
});
it.each(["connections", "agents"])("keeps the list after a failed %s refresh and recovers next cycle", async (failure) => {
  f.agents = [agent()]; f.eq.mockResolvedValue({ data: [connection()], error: null }); await mount();
  if (failure === "connections") f.eq.mockResolvedValueOnce({ data: null, error: new Error("offline") });
  else f.status = "error";
  await advance(); expect(container.textContent).toContain("Codex");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("We couldn’t load your agents. Try again.");
  f.status = "ready"; await advance(); expect(container.querySelector('[role="alert"]')).toBeNull();
});
it("does not expose the previous workspace snapshot after a workspace switch", async () => {
  f.agents = [agent()]; await mount(); expect(container.textContent).toContain("Codex");
  f.workspaceId = "other"; await mount(); expect(container.textContent).not.toContain("Codex");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
it("shows the cloud requirement without querying when no backend is configured", async () => {
  f.backend = false; await mount(); expect(container.textContent).toContain("Agents need the cloud. Configure a backend to register them.");
  expect(f.load).not.toHaveBeenCalled(); expect(f.eq).not.toHaveBeenCalled();
});

it("uses the server policy for owner controls, and renders a member's roles and levels as text", async () => {
  f.agents = [agent()]; await mount();
  expect(container.querySelector('select[aria-label="Workspace default"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Role of Codex"]')).not.toBeNull();
  expect(container.textContent).toContain("Only works");
  f.policy.mockResolvedValue({ level: "autonomous", can_edit: false }); await advance();
  expect(container.querySelector("select")).toBeNull();
  expect(container.querySelector('[aria-label="Role of Codex"]')).toBeNull();
  expect(container.textContent).toContain("Workspace default (Autonomous)");
  expect(container.textContent).toContain("Only the workspace owner can change roles and autonomy.");
});
it("updates workspace autonomy immediately and explains that Ask first stops all agents", async () => {
  f.agents = [agent()]; await mount();
  const select = container.querySelector('select[aria-label="Workspace default"]') as HTMLSelectElement;
  await act(async () => { select.value = "ask"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(f.workspace).toHaveBeenCalledWith("w", "ask");
  expect(container.textContent).toContain("Every agent is stopped");
  expect(container.textContent).toContain("This workspace is at Ask first, so every agent stops and asks a person, whatever its own level.");
  expect(container.textContent).toContain("Stopped: the workspace is at Ask first.");
});
it.each(["role", "autonomy"] as const)("keeps optimistic %s during polling and restores the row on failure", async (field) => {
  f.agents = [agent()]; await mount();
  let reject!: (reason: Error) => void;
  f[field].mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => {
    if (field === "role") (container.querySelector('[aria-label="Role of Codex"] button') as HTMLButtonElement).click();
    else {
      const select = container.querySelector('select[aria-label="Autonomy of Codex"]') as HTMLSelectElement;
      select.value = "autonomous"; select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await advance();
  if (field === "role") expect(container.querySelector('[aria-label="Role of Codex"] button')?.getAttribute("aria-pressed")).toBe("true");
  else expect((container.querySelector('select[aria-label="Autonomy of Codex"]') as HTMLSelectElement).value).toBe("autonomous");
  await act(async () => reject(new Error("Save failed.")));
  expect(container.querySelector("li [role='alert']")?.textContent).toBe("Save failed.");
  if (field === "role") expect(container.querySelector('[aria-label="Role of Codex"] button')?.getAttribute("aria-pressed")).toBe("false");
  else expect((container.querySelector('select[aria-label="Autonomy of Codex"]') as HTMLSelectElement).value).toBe("workspace");
});
