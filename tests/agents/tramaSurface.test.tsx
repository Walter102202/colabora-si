// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { TramaSurface } from "@/components/agents/assistant/TramaSurface";
import { refreshAgentConversation, settleAgentProposal, useAgentConversation, type PersonMessage } from "@/lib/agentConversation";
import { useStore } from "@/lib/store";
import { createPage } from "@/lib/factories";
import { useAgentsStore, type AgentRow } from "@/lib/agentsStore";
import { buildDecisionsHome } from "@/lib/agentHome";
import { useAgentTasks, type TaskRow, type ApprovalRow } from "@/lib/agentTasks";
import { startRecorder, uploadWav } from "@/lib/agentVoice";
import { createTask, decideApproval } from "@/lib/agentActions";
import { useAgentLessons, type LessonRow } from "@/lib/agentLessons";
import { useAgentSources, type DiscrepancyRow } from "@/lib/agentSources";
import { HOME_URL } from "@/lib/routes";

vi.mock("@/lib/agentActions", () => ({ createTask: vi.fn(), decideApproval: vi.fn() }));
vi.mock("@/lib/agentConversation", async (original) => ({ ...await original<object>(), settleAgentProposal: vi.fn(), refreshAgentConversation: vi.fn(async () => {}) }));
vi.mock("@/lib/agentClient", async (original) => ({ ...await original<object>(), getAgentClient: () => ({}) }));
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
  useAgentLessons.setState({ lessons: {}, subscribe: vi.fn(() => () => {}) });
  useAgentSources.setState({ discrepancies: {}, subscribe: vi.fn(() => () => {}) });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
const mount = () => act(() => root.render(<MemoryRouter initialEntries={["/p/page"]}><TramaSurface workspaceId="w" userId="person" /><Location /></MemoryRouter>));
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const originalCreateAgent = useAgentsStore.getState().createAgent;

it("sends pasted composer text as a direct person request", async () => {
  mount(); act(() => button("Talk to Trama").click());
  const textarea = document.querySelector("textarea")!;
  act(() => textarea.dispatchEvent(new Event("paste", { bubbles: true })));
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Create a job for this page");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Send").click());
  const send = vi.mocked(useAgentConversation.getState().send);
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0].body).toBe("Create a job for this page");
  expect(send.mock.calls[0][0].context?.pasted).toBeFalsy();
});

it.each([
  [1, 0, "1 lesson to review"], [2, 0, "2 lessons to review"],
  [0, 1, "1 difference to settle"], [2, 1, "2 lessons and 1 difference to review"],
  [0, 0, ""],
] as const)("announces %s lessons and %s differences without asking", (lessons, differences, text) => {
  const lesson = (id: string, workspace_id = "w", status = "proposed") => ({ id, workspace_id, status, created_at: "2026-11-01" } as LessonRow);
  const difference = (id: string, workspace_id = "w", status = "open") => ({ id, workspace_id, status, created_at: "2026-11-01" } as DiscrepancyRow);
  useAgentLessons.setState({ lessons: Object.fromEntries([lesson("foreign", "other"), lesson("accepted", "w", "accepted"), ...Array.from({ length: lessons }, (_, i) => lesson(`l${i}`))].map((row) => [row.id, row])) });
  useAgentSources.setState({ discrepancies: Object.fromEntries([difference("foreign", "other"), difference("resolved", "w", "resolved"), ...Array.from({ length: differences }, (_, i) => difference(`d${i}`))].map((row) => [row.id, row])) });
  mount();
  expect(useAgentLessons.getState().subscribe).toHaveBeenCalledWith("w");
  expect(useAgentSources.getState().subscribe).toHaveBeenCalledWith("w");
  const links = [...document.querySelectorAll("a")].filter((a) => /lesson|difference/.test(a.textContent ?? ""));
  expect(links.map((a) => a.textContent)).toEqual(text ? [text] : []);
  if (text) {
    expect(links[0].getAttribute("href")).toBe(HOME_URL);
    expect(document.getElementById(button("Talk to Trama").getAttribute("aria-describedby")!)?.textContent).toContain(text);
  }
});

it("hides the old conversation and cut and shows the empty state", () => {
  useAgentConversation.setState({ messages: [message({ body: "Old topic" }), message({ id: "cut", seq: 2, kind: "system", body: "New conversation", outcome: { kind: "conversation_reset" } })] });
  mount(); act(() => button("Talk to Trama").click());
  expect(document.body.textContent).not.toContain("Old topic");
  expect(document.body.textContent).not.toContain("New conversation");
  expect(document.body.textContent).toContain("Connects, coordinates, stays with you.");
});

it.each([true, false])("starts once, preserves the draft, and reports success=%s", async (success) => {
  let finish!: (value: boolean) => void;
  const reset = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  useAgentConversation.setState({ messages: [message({})], newConversation: reset });
  mount(); act(() => button("Talk to Trama").click());
  const textarea = document.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Unsent draft");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const action = [...document.querySelectorAll("button")].find((b) => b.textContent === "New conversation")!;
  act(() => { action.click(); action.click(); });
  expect(reset).toHaveBeenCalledOnce();
  await act(async () => finish(success));
  expect(textarea.value).toBe("Unsent draft");
  if (success) expect(document.activeElement).toBe(textarea);
  else expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not start a new conversation.");
});

it("the store creates a chat agent without issuing a token", async () => {
  const api = await import("@/lib/agentClient");
  vi.spyOn(api, "getAgentClient").mockReturnValue({ functions: { invoke: vi.fn(async () => ({ data: { agent_id: "new" }, error: null })) } } as unknown as ReturnType<typeof api.getAgentClient>);
  const issueToken = vi.fn(); useAgentsStore.setState({ workspaceId: "w", issueToken });
  const { agentInputFor } = await import("@/lib/agentDefaults");
  expect(await originalCreateAgent(agentInputFor("Helper", "codex", "worker"), { issueToken: false })).toEqual({ agentId: "new", token: null });
  expect(issueToken).not.toHaveBeenCalled();
});

it.each(["accept", "cancel", "settled", "failure"])("handles an agent proposal: %s", async (outcome) => {
  const taskPage = createPage({ id: "task-db", database: { id: "d", properties: [{ id: "status", name: "Status", type: "agentStatus" }], rows: [], views: [] } });
  useStore.setState({ syncWorkspaceId: "w", pages: { "task-db": taskPage } });
  useAgentConversation.setState({ messages: [message({ id: "proposal", direction: "out", outcome: { kind: "agent_proposed", name: "Helper", harness: "codex", role: "worker" } })] });
  const create = vi.fn().mockResolvedValue({ agentId: "new", token: null });
  if (outcome === "failure") create.mockRejectedValue(new Error("offline"));
  useAgentsStore.setState({ createAgent: create });
  vi.mocked(settleAgentProposal).mockReset().mockResolvedValue({ name: "Helper", harness: "codex", role: "worker" });
  if (outcome === "settled") vi.mocked(settleAgentProposal).mockRejectedValue(new Error("already_settled"));
  mount(); act(() => button("Talk to Trama").click());
  const action = [...document.querySelectorAll("button")].find((node) => node.textContent === (outcome === "cancel" ? "Cancel" : "Create agent"))!;
  await act(async () => { action.click(); action.click(); });
  expect(settleAgentProposal).toHaveBeenCalledExactlyOnceWith("proposal", outcome !== "cancel");
  if (outcome === "accept" || outcome === "failure") expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "Helper", grants: [{ pageId: "task-db", scopes: ["read", "write", "comment"], inherit: true }] }), { issueToken: false });
  else expect(create).not.toHaveBeenCalled();
  if (outcome === "failure") expect(document.querySelector('[role="alert"]')?.textContent).toContain("We couldn’t create this agent.");
  if (outcome === "settled") expect(refreshAgentConversation).toHaveBeenCalledWith("w");
});

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
  // A developer's .env.local may run the managed Trama; this test describes the self-hosted surface.
  vi.stubEnv("VITE_TRAMA_MANAGED", "");
  useAgentsStore.setState({ agents: [], status: "loading" });
  useAgentConversation.setState({ messages: [message({ needs_reply: true, created_at: new Date(Date.now() - 61_000).toISOString() })] });
  mount();
  expect(document.body.textContent).not.toContain("Enable Trama");
  expect(document.body.textContent).toContain("Trama is not answering right now. Your message stays here.");
  act(() => useAgentsStore.setState({ status: "ready" }));
  expect(document.body.textContent).toContain("Enable Trama");
  act(() => button("Talk to Trama").click());
  expect(document.querySelector('[role="log"]')?.textContent).toContain("Trama is not answering right now. Your message stays here.");
  expect(document.querySelector('[data-trama-surface] > [role="status"]')).toBeNull();
});

it.each(["start", "decline"])("settles work through the server once: %s", async (action) => {
  vi.stubEnv("VITE_TRAMA_MANAGED", "1");
  const api = await import("@/lib/agentClient");
  const rpc = vi.fn(async () => ({ data: { task_id: "task", page_id: "page" }, error: null }));
  vi.spyOn(api, "getAgentClient").mockReturnValue({ rpc } as unknown as ReturnType<typeof api.getAgentClient>);
  // The original can be outside the 50-message window: only the server resolves it.
  useAgentConversation.setState({ messages: [message({ id: "reply", direction: "out", outcome: { kind: "work_proposed", page_id: "page", page_title: "Home", summary: "Create five tasks on Home.", message_id: "original" } })] });
  mount(); act(() => button("Talk to Trama").click());
  expect(rpc).not.toHaveBeenCalled();
  await act(async () => { button(action === "start" ? "Do it on Home" : "Not now on Home").click(); button(action === "start" ? "Do it on Home" : "Not now on Home").click(); });
  expect(rpc).toHaveBeenCalledExactlyOnceWith(action === "start" ? "start_proposed_work" : "decline_proposed_work", { p_message_id: "reply" });
  expect(createTask).not.toHaveBeenCalled();
  if (action === "start") expect(host.querySelector("output")?.textContent).toBe("/p/page?task=task");
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

it.each([
  ["task_exists", "This page already has an active task. Finish or close it first, or ask me from another page."],
  ["not_found", "This proposal is no longer available."],
  ["already_settled", "This proposal was already answered."],
  ["no_objective", "This proposal has nothing to start. Ask Trama again."],
  ["forbidden", "You are not allowed to do that."],
  ["budget_exceeded", "This workspace reached its monthly agent budget."],
])("shows a readable proposal error for %s", async (code, text) => {
  vi.stubEnv("VITE_TRAMA_MANAGED", "1");
  const api = await import("@/lib/agentClient");
  const rpc = vi.fn(async () => ({ data: null, error: { message: code } }));
  vi.spyOn(api, "getAgentClient").mockReturnValue({ rpc } as unknown as ReturnType<typeof api.getAgentClient>);
  useAgentConversation.setState({ messages: [message({ id: "reply", direction: "out", outcome: { kind: "work_proposed", page_title: "Home", summary: "Create tasks on Home." } })] });
  mount(); act(() => button("Talk to Trama").click());
  for (const label of ["Do it on Home", "Not now on Home"]) {
    await act(async () => button(label).click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(text);
    expect(button("Do it on Home")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Started.");
  }
});

it.each(["start", "decline"])("labels pending work settlement accurately: %s", async (action) => {
  vi.stubEnv("VITE_TRAMA_MANAGED", "1");
  const api = await import("@/lib/agentClient");
  let finish!: (value: object) => void;
  const rpc = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  vi.spyOn(api, "getAgentClient").mockReturnValue({ rpc } as unknown as ReturnType<typeof api.getAgentClient>);
  useAgentConversation.setState({ messages: [message({ id: "reply", direction: "out", outcome: { kind: "work_proposed", page_title: "Home", summary: "Create tasks on Home." } })] });
  mount(); act(() => button("Talk to Trama").click());
  act(() => button(action === "start" ? "Do it on Home" : "Not now on Home").click());
  expect(button("Do it on Home").textContent).toBe(action === "start" ? "Starting…" : "Do it");
  expect(button("Not now on Home").textContent).toBe(action === "decline" ? "Closing…" : "Not now");
  expect(button("Do it on Home").disabled && button("Not now on Home").disabled).toBe(true);
  await act(async () => finish({ data: { task_id: "task", page_id: "page" }, error: null }));
});

const actionApproval = (id: string, taskId: string, over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id, task_id: taskId, run_id: null, kind: "action", action: "publish_page", params: {}, artifact_version: 1,
  question: "Publish the plan", options: ["approve", "reject"], status: "pending", decision: null,
  response: null, decided_by: null, decided_at: null, expires_at: "2099-01-01T00:00:00Z", created_at: "2026-11-03T00:00:00Z", ...over,
});
it.each(["approve", "reject"] as const)("decides a pending action from the chat using the person's %s click", async (decision) => {
  vi.stubEnv("VITE_TRAMA_MANAGED", "1");
  const own = task("own"), foreign = task("foreign", { workspace_id: "other" }), someone = task("someone", { owner_user_id: "someone" });
  const pending = actionApproval("pending", own.id);
  useAgentTasks.setState({ tasks: { own, foreign, someone }, approvals: { pending, foreign: actionApproval("foreign", foreign.id), someone: actionApproval("someone", someone.id) } });
  let finish!: (value: { status: string }) => void;
  vi.mocked(decideApproval).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  mount(); act(() => button("Talk to Trama").click());
  const section = document.querySelector('[aria-label="Needs your decision"]')!;
  expect(section).not.toBeNull();
  expect(section.querySelectorAll("button")).toHaveLength(2);
  expect(section.compareDocumentPosition(document.querySelector('[aria-label="Message to the agent"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const action = [...section.querySelectorAll("button")].find((b) => b.textContent === (decision === "approve" ? "Approve" : "Reject"))!;
  act(() => { action.click(); action.click(); });
  expect(decideApproval).toHaveBeenCalledExactlyOnceWith("pending", decision, null);
  await act(async () => {});
  expect(action.disabled).toBe(true);
  await act(async () => {
    if (decision === "approve") useAgentTasks.setState({ approvals: { ...useAgentTasks.getState().approvals, pending: { ...pending, status: "decided", decision } } });
    finish({ status: "decided" });
  });
  expect(document.querySelector('[aria-label="Needs your decision"]')?.textContent).toContain(decision === "approve" ? "Approved." : "Denied.");
  act(() => useAgentTasks.setState({ approvals: { ...useAgentTasks.getState().approvals, pending: { ...pending, status: "decided", decision } } }));
  expect(document.querySelector('[aria-label="Needs your decision"]')).toBeNull();
});
it.each(["none", "decided", "terminal"])("does not show chat decisions for %s approvals", (state) => {
  vi.stubEnv("VITE_TRAMA_MANAGED", "1");
  const own = task("own", state === "terminal" ? { state: "done" } : {});
  useAgentTasks.setState({ tasks: { own }, approvals: state === "none" ? {} : { a: actionApproval("a", own.id, state === "decided" ? { status: "decided" } : {}) } });
  mount(); act(() => button("Talk to Trama").click());
  expect(document.querySelector('[aria-label="Needs your decision"]')).toBeNull();
  expect(decideApproval).not.toHaveBeenCalled();
});

it("keeps a rejected approval request actionable and shows its error", async () => {
  vi.stubEnv("VITE_TRAMA_MANAGED", "1");
  const own = task("own");
  useAgentTasks.setState({ tasks: { own }, approvals: { a: actionApproval("a", own.id) } });
  vi.mocked(decideApproval).mockRejectedValueOnce(new Error("The task changed state. Refresh and try again."));
  mount(); act(() => button("Talk to Trama").click());
  const section = document.querySelector('[aria-label="Needs your decision"]')!;
  await act(async () => [...section.querySelectorAll("button")].find((b) => b.textContent === "Approve")!.click());
  expect(section.textContent).toContain("The task changed state. Refresh and try again.");
  expect(section.textContent).not.toContain("Approved.");
  expect(section.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
});

it.each(["send", "decline", "add", "send only", "stale brief"])("confirms a proposed agent message once: %s", async (action) => {
  vi.stubEnv("VITE_TRAMA_MANAGED", "1");
  const api = await import("@/lib/agentClient");
  const rpc = vi.fn(async () => ({ data: { task_id: "task", page_id: "page" }, error: action === "stale brief" ? { message: "brief_out_of_sync" } : null }));
  vi.spyOn(api, "getAgentClient").mockReturnValue({ rpc } as unknown as ReturnType<typeof api.getAgentClient>);
  useAgentConversation.setState({ messages: [message({ id: "reply", direction: "out", outcome: { kind: "message_proposed", task_id: "task", task_title: "Research", agent_name: "Codex", text: "Use local dates.", ...(["add", "send only", "stale brief"].includes(action) ? { adds_requirement: true } : {}) } })] });
  mount(); act(() => button("Talk to Trama").click());
  expect(rpc).not.toHaveBeenCalled();
  if (["add", "send only"].includes(action)) {
    expect(document.body.textContent).toContain("Add to the brief and tell Codex?");
    expect(document.body.textContent).toContain("Use local dates.");
    expect(button("Add and send to Codex").textContent).toBe("Add and send");
    expect(button("Send only to Codex").textContent).toBe("Send only");
  }
  await act(async () => { const target = button(["add", "stale brief"].includes(action) ? "Add and send to Codex" : action === "send only" ? "Send only to Codex" : action === "send" ? "Send to Codex" : "Not now for Codex"); target.click(); target.click(); });
  expect(rpc).toHaveBeenCalledExactlyOnceWith(action === "decline" ? "decline_proposed_work" : "send_proposed_message", { p_message_id: "reply", ...(action === "decline" ? {} : { p_add_requirement: ["add", "stale brief"].includes(action) }) });
  if (action === "stale brief") {
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("The page has unsaved brief changes. Use Update brief on the task, then try again.");
    expect(button("Add and send to Codex").disabled).toBe(false);
  }
});
