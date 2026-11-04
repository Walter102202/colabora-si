// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TramaSurface } from "@/components/agents/assistant/TramaSurface";
import { openTramaTaskDraft, useAgentProgressContext } from "@/lib/agentTramaContext";
import { useAgentConversation } from "@/lib/agentConversation";
import { useAgentTasks, type TaskRow } from "@/lib/agentTasks";
import { useAgentsStore, type AgentRow } from "@/lib/agentsStore";
import { useAgentLessons } from "@/lib/agentLessons";
import { useAgentSources } from "@/lib/agentSources";
import { useStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth";
import { createPage } from "@/lib/factories";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import { startRecorder, uploadWav } from "@/lib/agentVoice";

vi.mock("@/lib/agentClient", async (original) => ({ ...await original<object>(), getAgentClient: () => ({}) }));
vi.mock("@/lib/agentVoice", async (original) => ({ ...await original<object>(), startRecorder: vi.fn(), uploadWav: vi.fn() }));
let host: HTMLDivElement, root: Root;
const send = vi.fn(async () => true);
const baseTask = (mockCard("1") as TaskCardData).task;
const task = (id: string): TaskRow => ({ ...baseTask, id, workspace_id: "w", db_page_id: "db", row_page_id: id, parent_task_id: null, owner_user_id: "person", state: "working", title: `Task ${id}` });
function SwitchTask() {
  const navigate = useNavigate();
  const { search } = useLocation();
  useEffect(() => { useAgentProgressContext.setState({ context: { owner: "fixture", workspaceId: "w", userId: "person", databaseId: "db", pageId: new URLSearchParams(search).get("progressRow") ?? "a" } }); }, [search]);
  return <><button onClick={() => void navigate("/p/db?progressRow=a")}>Task A</button><button onClick={() => void navigate("/p/db?progressRow=b")}>Task B</button></>;
}
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const textButton = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === label)!;
const draftEvent = (id: string, prompt = `Explain task ${id}`) => openTramaTaskDraft({ workspaceId: "w", taskId: id, pageId: id, prompt });
const type = (text: string) => act(() => {
  const input = document.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  useStore.setState({ syncWorkspaceId: "w", pages: { db: createPage({ id: "db", title: "Jobs" }), a: createPage({ id: "a", title: "Task A" }), b: createPage({ id: "b", title: "Task B" }) } });
  useAuthStore.setState({ user: { id: "person" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> });
  useAgentConversation.setState({ messages: [], failed: null, subscribe: () => () => {}, send });
  useAgentsStore.setState({ agents: [{ id: "trama", workspace_id: "w", is_platform: true, revoked_at: null } as AgentRow], workspaceId: "w", status: "ready", load: async () => {} });
  useAgentTasks.setState({ workspaceId: "w", tasks: { a: task("a"), b: task("b") }, approvals: {}, runs: {}, subscribe: () => () => {} });
  useAgentProgressContext.setState({ context: null });
  useAgentLessons.setState({ lessons: {}, subscribe: () => () => {} });
  useAgentSources.setState({ discrepancies: {}, subscribe: () => () => {} });
  act(() => root.render(<MemoryRouter initialEntries={["/p/db?progressRow=a"]}><TramaSurface workspaceId="w" userId="person" /><SwitchTask /></MemoryRouter>));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("opens an explicit contextual draft without sending, then sends only on the person's click", async () => {
  act(() => draftEvent("a"));
  expect(send).not.toHaveBeenCalled();
  expect(document.querySelector("textarea")?.value).toBe("Explain task a");
  expect(document.body.textContent).toContain("Context: Task A");
  await act(async () => button("Send").click());
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: "Explain task a", context: expect.objectContaining({ page_id: "a" }) }));
});

it("keeps an unsent draft bound to its original task when selection changes", async () => {
  act(() => draftEvent("a", "My exact unsent feedback"));
  act(() => textButton("Task B").click());
  act(() => draftEvent("b"));
  expect(document.querySelector("textarea")?.value).toBe("My exact unsent feedback");
  expect(document.body.textContent).toContain("Context: Task A");
  expect(document.body.textContent).toContain("Your unsent draft is kept.");
  expect(send).not.toHaveBeenCalled();
  await act(async () => button("Send").click());
  expect(send.mock.calls[0]).toEqual([expect.objectContaining({ body: "My exact unsent feedback", context: expect.objectContaining({ page_id: "a" }) })]);
  act(() => draftEvent("b"));
  expect(document.querySelector("textarea")?.value).toBe("Explain task b");
  await act(async () => button("Send").click());
  expect(send.mock.calls[1]).toEqual([expect.objectContaining({ context: expect.objectContaining({ page_id: "b" }) })]);
});

it("also binds typed text and keeps it when a suggested question is sent", async () => {
  act(() => button("Talk to Trama").click());
  type("Do not lose my notes");
  act(() => textButton("Task B").click());
  await act(async () => textButton("What is blocking this task?").click());
  expect(document.querySelector("textarea")?.value).toBe("Do not lose my notes");
  expect(send.mock.calls[0]).toEqual([expect.objectContaining({ body: "What is blocking this task?", context: expect.objectContaining({ page_id: "b" }) })]);
  await act(async () => button("Send").click());
  expect(send.mock.calls[1]).toEqual([expect.objectContaining({ body: "Do not lose my notes", context: expect.objectContaining({ page_id: "a" }) })]);
});

it("ignores foreign workspace, wrong page, and unselected task draft events", () => {
  act(() => {
    openTramaTaskDraft({ workspaceId: "other", taskId: "a", pageId: "a", prompt: "Wrong workspace" });
    openTramaTaskDraft({ workspaceId: "w", taskId: "a", pageId: "b", prompt: "Wrong row" });
    draftEvent("b");
  });
  expect(document.querySelector("textarea")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it("clearing a draft allows context to follow the selected task", async () => {
  act(() => draftEvent("a"));
  act(() => textButton("Task B").click());
  type("");
  act(() => draftEvent("b"));
  expect(document.body.textContent).toContain("Context: Task B");
  await act(async () => button("Send").click());
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context: expect.objectContaining({ page_id: "b" }) }));
});

it("keeps a voice transcript bound to the task where recording started", async () => {
  const api = await import("@/lib/agentClient");
  vi.spyOn(api, "getAgentClient").mockReturnValue({ auth: { getSession: async () => ({ data: { session: { access_token: "local-test" } } }) } } as unknown as ReturnType<typeof api.getAgentClient>);
  vi.mocked(startRecorder).mockResolvedValue({ stop: async () => new ArrayBuffer(8), cancel: vi.fn() });
  vi.mocked(uploadWav).mockResolvedValue({ clip_id: "clip", transcript: "My feedback for task A", duration_ms: 1000 });
  act(() => button("Talk to Trama").click());
  await act(async () => button("Talk to the agent").click());
  await act(async () => button("Stop and transcribe").click());
  expect(document.querySelector("textarea")?.value).toBe("My feedback for task A");
  act(() => textButton("Task B").click());
  await act(async () => button("Send").click());
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: "My feedback for task A", context: expect.objectContaining({ page_id: "a" }) }));
});

it("uses the database context after Progress is hidden even if progressRow remains in the URL", async () => {
  act(() => useAgentProgressContext.setState({ context: null }));
  act(() => button("Talk to Trama").click());
  type("Summarize the board");
  await act(async () => button("Send").click());
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: "Summarize the board", context: expect.objectContaining({ page_id: "db" }) }));
});
