// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionCard, TaskView } from "@/components/agents/panel";
import { cardDataFrom, type TaskCardData } from "@/lib/agentCard";
import { mockCard } from "@/components/agents/card/mock";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const noop = async () => {};

describe("questions that do not block", () => {
  it("DecisionCard says the agent keeps working", () => {
    const data = cardDataFrom(mockCard("side-question")) as TaskCardData;
    act(() => root.render(createElement(DecisionCard, { approval: data.questions![0], onDecide: noop, nonBlocking: true })));
    expect(container.textContent).toContain("The agent keeps working while you answer.");
  });

  it("TaskView shows them with the next-step hint and answers each one by its own id", async () => {
    const data = cardDataFrom(mockCard("side-question")) as TaskCardData;
    const decided: string[] = [];
    act(() => root.render(createElement(TaskView, {
      ...data, approval: null, subtasks: [], reviewerName: null, agent: null,
      openQuestions: data.questions ?? [],
      onDecideQuestion: async (id: string) => { decided.push(id); },
      onMessage: noop, onClose: noop, onDecide: noop, onReview: noop, onOpenTask: () => {}, onOpenPage: () => {},
    })));
    expect(container.textContent).toContain(data.questions![0].question);
    expect(container.textContent).toContain("What will happen");
    const ignore = [...container.querySelectorAll("button")].find((b) => b.textContent === "Ignore")!;
    await act(async () => { ignore.click(); });
    expect(decided).toEqual([data.questions![0].id]);
  });
});
