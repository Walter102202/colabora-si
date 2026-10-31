// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { TramaSurface } from "@/components/agents/assistant/TramaSurface";
import { useAgentConversation, type PersonMessage } from "@/lib/agentConversation";
import { useAgentsStore, type AgentRow } from "@/lib/agentsStore";
import { buildDecisionsHome } from "@/lib/agentHome";
import { useAgentTasks, type TaskRow, type ApprovalRow } from "@/lib/agentTasks";
import { startRecorder, uploadWav } from "@/lib/agentVoice";
import { createTask } from "@/lib/agentActions";

vi.mock("@/lib/agentActions", () => ({ createTask: vi.fn() }));
vi.mock("@/lib/agentClient", () => ({ getAgentClient: () => ({}), agentErrorMessage: String }));
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
  useAgentTasks.setState({ tasks: {}, approvals: {}, runs: {}, subscribe: vi.fn(() => () => {}) });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
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

const task = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({ id, workspace_id: "w", row_page_id: "page-" + id, title: id, owner_user_id: "person", state: "working", request_kind: null, updated_at: "2026-10-01T00:00:00Z", last_activity_at: null, active_run_id: null, delegate_agent_id: "trama", ...over } as TaskRow);
const approval = (id: string, taskId: string, blocking: boolean, at: string): ApprovalRow => ({ id, task_id: taskId, status: "pending", kind: "elicitation", question: id, blocking, created_at: at } as ApprovalRow);
function fixture() {
  const tasks = { old: task("Old blocking", { state: "input_required", waiting_on: "human" }), minor: task("Nonblocking"), request: task("Request", { request_kind: "fill", state: "input_required" }), other: task("Foreign", { workspace_id: "other", state: "input_required" }) };
  const approvals = { a: approval("a", tasks.old.id, true, "2026-10-02T00:00:00Z"), b: approval("b", tasks.minor.id, false, "2026-10-01T00:00:00Z") };
  useAgentTasks.setState({ tasks, approvals });
  return buildDecisionsHome({ tasks: Object.values(tasks).filter((t) => t.workspace_id === "w"), approvals: Object.values(approvals), runs: {}, agents: [], userId: "person", now: Date.now() });
}
const pointer = (element: Element, type: "over" | "out", pointerType = "mouse", relatedTarget: EventTarget | null = null) => act(() => element.dispatchEvent(new PointerEvent("pointer" + type, { bubbles: true, pointerType, relatedTarget })));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const firstLink = () => [...document.querySelectorAll("a")].find((a) => a.textContent?.startsWith("First:"));

it("opens from the English greeting without sending, while a question still sends", async () => {
  mount();
  const greeting = [...document.querySelectorAll("button")].find((b) => b.textContent === "What are you up to?");
  expect(greeting).toBeDefined();
  act(() => greeting!.click());
  expect(document.activeElement?.tagName).toBe("TEXTAREA");
  expect(useAgentConversation.getState().send).not.toHaveBeenCalled();
  const question = [...document.querySelectorAll("button")].find((b) => b.textContent === "Can you summarize this page?")!;
  await act(async () => question.click());
  expect(useAgentConversation.getState().send).toHaveBeenCalledWith(expect.objectContaining({ body: "Can you summarize this page?" }));
  expect(useAgentConversation.getState().send).toHaveBeenCalledTimes(1);
});

it("subscribes on direct pages and matches Home count, order and deep link", () => {
  vi.useFakeTimers(); const home = fixture(); mount();
  expect(useAgentTasks.getState().subscribe).toHaveBeenCalledWith("w");
  expect(document.body.textContent).toContain(home.waiting.length + " decisions wait for you");
  expect(firstLink()).toBeUndefined();
  pointer(button("Talk to Trama"), "over"); advance(349); expect(firstLink()).toBeUndefined();
  advance(1); expect(firstLink()?.textContent).toBe("First: " + home.waiting[0].title);
  expect(firstLink()?.getAttribute("href")).toBe(home.waiting[0].href);
  const description = document.getElementById(button("Talk to Trama").getAttribute("aria-describedby")!);
  expect(description?.textContent).toContain("First: " + home.waiting[0].title);
  act(() => useAgentTasks.setState({ approvals: { a: useAgentTasks.getState().approvals.a } }));
  expect(document.body.textContent).toContain("1 decision waits for you");
});

it("keeps the reveal across the group, dismisses with Escape and respects the jump cooldown", () => {
  vi.useFakeTimers(); fixture(); mount();
  const trigger = button("Talk to Trama"), body = trigger.firstElementChild!;
  const animate = vi.fn(); Object.defineProperty(body, "animate", { value: animate });
  pointer(trigger, "over"); advance(350);
  expect(animate).toHaveBeenCalledTimes(1);
  expect(body.tagName).toBe("SPAN"); expect(trigger.style.background).toBe("transparent");
  pointer(trigger, "out", "mouse", firstLink()!); pointer(firstLink()!, "over", "mouse", trigger); advance(600);
  expect(firstLink()).toBeDefined();
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  advance(1000); expect(firstLink()).toBeUndefined();
  pointer(trigger, "over"); advance(350); expect(animate).toHaveBeenCalledTimes(1);
  pointer(trigger, "out", "mouse", document.body); advance(499); expect(firstLink()).toBeDefined();
  advance(1); expect(firstLink()).toBeUndefined();
  advance(3000); pointer(trigger, "over"); expect(animate).toHaveBeenCalledTimes(2);
});

it("reveals on keyboard focus but not when conversation closing restores focus", () => {
  fixture(); mount();
  const trigger = button("Talk to Trama"); vi.spyOn(trigger, "matches").mockReturnValue(true);
  act(() => trigger.focus()); expect(firstLink()).toBeDefined();
  act(() => trigger.click()); expect(firstLink()).toBeUndefined();
  act(() => button("Close Trama").click());
  expect(document.activeElement).toBe(trigger); expect(firstLink()).toBeUndefined();
});

it.each([false, true])("only the wrapper jumps; reduced motion=%s still allows work information", (reduced) => {
  vi.useFakeTimers(); vi.spyOn(window, "matchMedia").mockReturnValue({ matches: reduced } as MediaQueryList);
  useAgentTasks.setState({ tasks: { working: task("Prepare release") } }); mount();
  const trigger = button("Talk to Trama"), animate = vi.fn(); Object.defineProperty(trigger.firstElementChild!, "animate", { value: animate });
  expect(document.body.textContent).not.toContain("In progress:");
  pointer(trigger, "over", "touch"); advance(1000); expect(animate).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("In progress:");
  pointer(trigger, "over"); advance(350);
  expect(animate).toHaveBeenCalledTimes(reduced ? 0 : 1);
  expect(document.body.textContent).toContain("In progress: Prepare release");
  act(() => trigger.click()); pointer(trigger, "over"); advance(350);
  expect(document.body.textContent).not.toContain("In progress:");
  expect(animate).toHaveBeenCalledTimes(reduced ? 0 : 1);
});
