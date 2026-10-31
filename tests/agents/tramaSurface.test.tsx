// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { TramaSurface } from "@/components/agents/assistant/TramaSurface";
import { useAgentConversation, type PersonMessage } from "@/lib/agentConversation";
import { useAgentsStore, type AgentRow } from "@/lib/agentsStore";
import { useAgentTasks } from "@/lib/agentTasks";
import { startRecorder, uploadWav } from "@/lib/agentVoice";
import { createTask } from "@/lib/agentActions";

vi.mock("@/lib/agentActions", () => ({ createTask: vi.fn() }));
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => null, agentErrorMessage: String }));
vi.mock("@/lib/agentVoice", async (original) => ({ ...(await original<typeof import("@/lib/agentVoice")>()), startRecorder: vi.fn(), uploadWav: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
const message = (over: Partial<PersonMessage>): PersonMessage => ({ id: "m", seq: 1, workspace_id: "w", direction: "in", channel: "surface", kind: "text", body: "The exact person's words", forwarded: false, outcome: null, created_at: new Date().toISOString(), ...over });
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  useAgentConversation.setState({ messages: [], failed: null, subscribe: () => () => {}, send: vi.fn(async () => true) });
  useAgentsStore.setState({ agents: [{ id: "trama", workspace_id: "w", is_platform: true, revoked_at: null } as AgentRow], workspaceId: "w", status: "ready", load: async () => {} });
  useAgentTasks.setState({ tasks: {} });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = () => act(() => root.render(<MemoryRouter initialEntries={["/p/page"]}><TramaSurface workspaceId="w" userId="person" /></MemoryRouter>));
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

it("stays visible when folded and restores focus after Escape", () => {
  mount();
  act(() => button("Hide suggestion").click());
  expect(localStorage.getItem("trama-folded")).toBe("1");
  expect(button("Talk to Trama")).not.toBeNull();
  act(() => button("Talk to Trama").click());
  expect(document.activeElement?.tagName).toBe("TEXTAREA");
  expect(document.body.textContent).toContain("Connects, coordinates, stays with you.");
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector('[aria-label="Trama conversation"]')).toBeNull();
  expect(document.activeElement).toBe(button("Talk to Trama"));
});

it("does not infer absence from loading and shows a real unanswered message", () => {
  useAgentsStore.setState({ agents: [], status: "loading" });
  useAgentConversation.setState({ messages: [message({ needs_reply: true, created_at: new Date(Date.now() - 61_000).toISOString() })] });
  mount();
  expect(document.body.textContent).not.toContain("Enable Trama");
  expect(document.body.textContent).toContain("Trama is not answering right now. Your message stays here.");
  act(() => useAgentsStore.setState({ status: "ready" }));
  expect(document.body.textContent).toContain("Enable Trama");
});

it("creates work only on the click using the original words and a stable retry key", async () => {
  const original = message({ id: "original" });
  useAgentConversation.setState({ messages: [original, message({ id: "reply", seq: 2, direction: "out", body: "The model's wording", outcome: { kind: "work_proposed", page_id: "page", message_id: "original" } })] });
  vi.mocked(createTask).mockResolvedValue({ task_id: "task", context_id: "context", brief_version: 1 });
  mount();
  act(() => button("Talk to Trama").click());
  expect(createTask).not.toHaveBeenCalled();
  const start = [...document.querySelectorAll("button")].find((b) => b.textContent === "Do it")!;
  await act(async () => { start.click(); start.click(); });
  expect(createTask).toHaveBeenCalledExactlyOnceWith("page", { objective: original.body }, "trama", { idempotencyKey: "proposal:original" });
});

it("can record again after review, blocks sending during capture, and cancels on close", async () => {
  const api = await import("@/lib/agentClient");
  const session = vi.spyOn(api, "getAgentClient").mockReturnValue({ auth: { getSession: async () => ({ data: { session: { access_token: "local" } } }) } } as unknown as ReturnType<typeof api.getAgentClient>);
  const cancel = vi.fn();
  vi.mocked(startRecorder).mockResolvedValue({ stop: async () => new ArrayBuffer(8), cancel });
  vi.mocked(uploadWav).mockResolvedValue({ clip_id: "clip", transcript: "Reviewed text", duration_ms: 1000 });
  mount(); act(() => button("Talk to Trama").click());
  await act(async () => button("Talk to the agent").click());
  await act(async () => button("Stop and transcribe").click());
  expect(document.querySelector("textarea")?.value).toBe("Reviewed text");
  await act(async () => button("Talk to the agent").click());
  expect(button("Stop and transcribe")).not.toBeNull();
  expect(button("Send").disabled).toBe(true);
  act(() => button("Close Trama").click());
  expect(cancel).toHaveBeenCalledOnce();
  session.mockRestore();
});
