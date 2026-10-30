// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeadReviewCard } from "@/components/agents/panel/LeadReviewCard";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import type { TaskRow } from "@/lib/agentTasks";
import { taskSubtitle } from "@/lib/agentTaskText";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

// submit_for_review sets review_state 'pending' on every delivery and close_task leaves it there.
const delivered = (overrides: Partial<TaskRow>): TaskRow => {
  const data = mockCard("1") as TaskCardData;
  return { ...data.task, state: "ready_for_review", review_state: "pending", review_rounds: 0, max_review_rounds: 2, active_run_id: null, ...overrides };
};
const card = (task: TaskRow) => {
  const data = mockCard("1") as TaskCardData;
  act(() => root.render(createElement(LeadReviewCard, { task, review: null, brief: data.brief, artifact: data.artifact, onReview: async () => {} })));
  return container.textContent ?? "";
};

describe("who reviews a delivered task", () => {
  it("a subtask is reviewed by the Lead of its parent", () => {
    const task = delivered({ parent_task_id: "parent-1" });
    expect(card(task)).toContain("Lead reviewing · round 1 of 2");
    expect(taskSubtitle(task, null, "Codex")).toBe("Lead reviewing · round 1 of 2");
  });
  it("a top-level task waits on the person", () => {
    const task = delivered({ parent_task_id: null });
    expect(card(task)).toContain("Waiting for your review");
    expect(card(task)).not.toContain("Lead reviewing");
    expect(taskSubtitle(task, null, "Codex")).toBe("waiting for your review");
  });
  it("a closed task shows no reviewing line, and keeps its round count", () => {
    expect(card(delivered({ parent_task_id: "parent-1", state: "done", acceptance: "accepted" }))).not.toContain("reviewing");
    const escalated = card(delivered({ parent_task_id: "parent-1", state: "done", acceptance: "accepted", review_rounds: 2 }));
    expect(escalated).not.toContain("reviewing");
    expect(escalated).toContain("Round 2 of 2 · escalated to you");
  });
});
