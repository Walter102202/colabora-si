// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeCards } from "@/components/agents/panel/HomeCards";
import { LessonCard } from "@/components/agents/panel/LessonCard";
import { acceptedLessons, proposalsOfTask, proposedLessons, type LessonRow, type LessonScope } from "@/lib/agentLessons";
import { buildDecisionsHome } from "@/lib/agentHome";
import { taskForPage, type AgentTasksState, type TaskRow } from "@/lib/agentTasks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); });

const lesson = (over: Partial<LessonRow> = {}): LessonRow => ({ id: "l1", workspace_id: "w", status: "proposed", body: "Dates are DD/MM/YYYY", example: "30/10/2026",
  scope: "page", scope_page_id: "db", scope_context_id: null, source_kind: "review", source_task_id: "t1", source_text: "c1 contradicted: wrong dates",
  decided_at: null, created_at: "2026-10-30T10:00:00Z", ...over });
const scopes: LessonScope[] = [{ scope: "context", label: "This project", context_id: "c" }, { scope: "page", label: "Reports", page_id: "db" }, { scope: "workspace", label: "Whole workspace" }];

function render(element: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(element));
  return host;
}
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;

describe("LessonCard", () => {
  it("shows what was really corrected and the current scope", () => {
    const host = render(createElement(LessonCard, { lesson: lesson(), scopes, onDecide: vi.fn() }));
    expect(host.textContent).toContain("c1 contradicted: wrong dates");
    expect((host.querySelector("select") as HTMLSelectElement).value).toBe("1");
  });
  it("accepts with the chosen scope", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const host = render(createElement(LessonCard, { lesson: lesson(), scopes, onDecide }));
    await act(async () => { button(host, "Accept").click(); });
    expect(onDecide).toHaveBeenCalledWith("accept", { text: "Dates are DD/MM/YYYY", example: "30/10/2026", scope: scopes[1] });
  });
  it("shows the server's refusal and stays open", async () => {
    const host = render(createElement(LessonCard, { lesson: lesson(), scopes, onDecide: vi.fn().mockRejectedValue(new Error("Only the workspace owner")) }));
    await act(async () => { button(host, "Accept").click(); });
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Only the workspace owner");
  });
});

it("the home section renders nothing when nothing waits", () => {
  expect(render(createElement(HomeCards, { title: "Lessons to review", items: [] })).childElementCount).toBe(0);
});

describe("selectors", () => {
  it("separate proposals, accepted lessons and tasks", () => {
    const rows = { a: lesson({ id: "a" }), b: lesson({ id: "b", status: "accepted", decided_at: "2026-10-30T11:00:00Z" }), c: lesson({ id: "c", source_task_id: "t2" }) };
    expect(proposedLessons(rows).map((l) => l.id)).toEqual(["a", "c"]);
    expect(acceptedLessons(rows).map((l) => l.id)).toEqual(["b"]);
    expect(proposalsOfTask(rows, "t2").map((l) => l.id)).toEqual(["c"]);
  });
});

describe("request tasks stay out of the task views", () => {
  const task = (over: Partial<TaskRow>) => ({ id: "t", row_page_id: "p", state: "working", owner_user_id: "u", updated_at: "2026-10-30T10:00:00Z",
    last_activity_at: null, closed_at: null, title: "Report", delegate_agent_id: null, active_run_id: null, request_kind: null, ...over }) as TaskRow;
  it("a request on the row does not take the panel", () => {
    const state = { tasks: { work: task({ id: "work", state: "done" }), req: task({ id: "req", request_kind: "lesson" }) } } as unknown as AgentTasksState;
    expect(taskForPage(state, "p")?.id).toBe("work");
  });
  it("a request alone leaves the row without a task", () => {
    const state = { tasks: { req: task({ id: "req", request_kind: "source_check" }) } } as unknown as AgentTasksState;
    expect(taskForPage(state, "p")).toBeNull();
  });
  it("a request is not an agent working for the person", () => {
    const home = buildDecisionsHome({ tasks: [task({ id: "req", request_kind: "lesson" })], approvals: [], runs: {}, agents: [], userId: "u", now: Date.parse("2026-10-30T12:00:00Z") });
    expect(home.working).toEqual([]);
  });
});
