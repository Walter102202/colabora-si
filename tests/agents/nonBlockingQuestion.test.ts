// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionCard, TaskView } from "@/components/agents/panel";
import { Card } from "@/components/agents/card/Card";
import { WaitingList } from "@/components/agents/card/WaitingList";
import { cardDataFrom, type TaskCardData, type WaitingListData } from "@/lib/agentCard";
import { mockActions, mockCard } from "@/components/agents/card/mock";

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
    expect(container.querySelector("header")?.textContent).toContain("Run working");
    const ignore = [...container.querySelectorAll("button")].find((b) => b.textContent === "Ignore")!;
    await act(async () => { ignore.click(); });
    expect(decided).toEqual([data.questions![0].id]);
  });

  it("the chat card shows every question waiting on the person, and marks only the side ones as not blocking", () => {
    const data = mockCard("question") as TaskCardData;
    const first = data.approval!;
    const second = { ...first, id: "ap-second", question: "Which tag goes on rows without email?", created_at: new Date().toISOString() };
    const side = (mockCard("side-question") as TaskCardData).questions![0];
    act(() => root.render(createElement(Card, { initial: { ...data, questions: [side], approvals_pending: [first, side, second] }, actions: mockActions("question") })));
    for (const q of [first, second, side]) expect(container.textContent).toContain(q.question);
    expect(container.textContent!.split("The agent keeps working while you answer.").length - 1).toBe(1);
  });

  it("the waiting list shows the text of a side question when nothing blocks", () => {
    const list = mockCard("list") as WaitingListData;
    const item = { ...list.items[1], approval: null, questions: [{ ...list.items[1].approval!, id: "ap-side", question: "Formal or casual tone?" }] };
    act(() => root.render(createElement(WaitingList, { data: { ...list, items: [item] }, busy: null, onShow: () => {}, onOpen: null })));
    expect(container.textContent).toContain("Has a question for you: Formal or casual tone?");
  });
});
