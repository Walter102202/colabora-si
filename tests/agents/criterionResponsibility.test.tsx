// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskView, type TaskViewProps } from "@/components/agents/panel/RowPanelView";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import type { ParentAcceptance } from "@/lib/agentCriterionReview";
import type { TaskRow } from "@/lib/agentTasks";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const noop = async () => {};
function props(): TaskViewProps {
  const data = mockCard("1") as TaskCardData;
  return {
    ...data, task: { ...data.task, review_state: "approved" }, subtasks: [], agent: null, reviewerName: "Claude Code",
    brief: { ...data.brief!, done_when: [
      { id: "person", text: "Approve the release design", check: "human", by: "person" },
      { id: "agent", text: "Look at the small-screen layout", check: "human", by: "agent" },
    ] },
    review: { ...data.review!, verdict: "approved", findings: [
      { criterion_id: "person", status: "verified", note: "Compared the release preview", evidence_ref: "design-preview" },
      { criterion_id: "agent", status: "contradicted", note: "The toolbar covers the last line", evidence_ref: "mobile-preview" },
    ] },
    onMessage: vi.fn(noop), onClose: vi.fn(noop), onDecide: vi.fn(noop), onReview: vi.fn(noop), onOpenTask: vi.fn(), onOpenPage: vi.fn(),
  };
}
const region = (name: string) => host.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
const verification = (id: string) => region("Verification").querySelector<HTMLElement>(`[data-criterion-id="${id}"]`)!;
const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === name)!;
const paragraphs = (node: Element) => [...node.querySelectorAll("p")].map((item) => item.textContent);

describe("criterion authorship and review responsibility", () => {
  it("keeps required human checks in acceptance and makes agent suggestions distinct in Plan and Work", () => {
    const input = props();
    input.jobCi = { state: "none", connected: false, checks: [], pending_human: [{ task_id: "child", criterion_id: "child-person", text: "Approve the accessibility checklist" }] };
    act(() => root.render(createElement(TaskView, input)));
    const required = [...region("Ready for you").querySelectorAll("li")].map((item) => item.textContent);
    expect(required).toEqual(["Approve the accessibility checklist", "Approve the release design"]);
    expect(region("Ready for you").textContent).not.toContain("Look at the small-screen layout");
    expect(verification("person").textContent).toContain("Waiting for you");
    expect(verification("agent").textContent).toContain("The Lead suggested you look");
    expect(verification("agent").textContent).not.toContain("Waiting for you");

    act(() => tab("Plan").click());
    const criteria = [...region("Acceptance criteria").querySelectorAll("li")];
    expect(criteria[0].textContent).toContain("Required human review");
    expect(criteria[1].textContent).toContain("The Lead suggested you look");
    expect(criteria[1].textContent).not.toContain("Required human review");
    expect(region("Ready for you").closest("[hidden]")).toBeNull();
    expect(input.onClose).not.toHaveBeenCalled();
  });

  it("preserves findings, evidence and readable responsibility metadata as separate content", () => {
    const input = props();
    input.review = { ...input.review!, outdated_by: "artifact" };
    act(() => root.render(createElement(TaskView, input)));
    const required = verification("person"), suggested = verification("agent");
    expect(required.textContent).toContain("verified");
    expect(required.textContent).toContain("Compared the release preview");
    expect(paragraphs(required)).toContain("Evidence: design-preview");
    expect(suggested.textContent).toContain("contradicted");
    expect(suggested.textContent).toContain("The toolbar covers the last line");
    expect(paragraphs(suggested)).toContain("Evidence: mobile-preview");
    // Long responsibility text gets its own paragraph rather than replacing
    // the finding or squeezing the criterion into the same unwrappable row.
    expect(paragraphs(suggested)).toContain("The Lead suggested you look");
    expect(region("Verification").textContent).toContain("Approved · by Claude Code · deliverable v2 · brief v2");
    expect(region("Verification").textContent).toContain("Review outdated:");
  });

  it("does not treat a suggestion or a required human check as verified when no review was loaded", () => {
    act(() => root.render(createElement(TaskView, { ...props(), review: null })));
    for (const id of ["person", "agent"]) expect(verification(id).textContent).toContain("not verified yet");
    expect(verification("person").textContent).toContain("Waiting for you");
    expect(verification("agent").textContent).toContain("The Lead suggested you look");
  });

  it("keeps missing authorship unspecified without modifying the saved brief", () => {
    const input = props();
    input.brief = { ...input.brief!, done_when: [{ id: "legacy", text: "Check the old preview", check: "human" }] };
    const saved = structuredClone(input.brief);
    act(() => root.render(createElement(TaskView, input)));
    expect(paragraphs(verification("legacy"))).toContain("Human review");
    expect(verification("legacy").textContent).not.toContain("Waiting for you");
    expect(region("Ready for you").querySelector("ul")).toBeNull();
    act(() => tab("Plan").click());
    expect(region("Acceptance criteria").textContent).toContain("legacy · Human review");
    expect(input.brief).toEqual(saved);
  });
});

describe("human checks after acceptance", () => {
  const cases: { name: string; task: Partial<TaskRow>; parentAcceptance?: ParentAcceptance; text: string }[] = [
    { name: "accepted parent", task: { parent_task_id: null, closed_by: "person" }, text: "Human review settled with acceptance" },
    { name: "accepted parent without a human closer", task: { parent_task_id: null, closed_by: null }, text: "Human review settled with acceptance" },
    { name: "subtask directly accepted by a person", task: { parent_task_id: "parent", closed_by: "person" }, parentAcceptance: "pending", text: "Human review settled with acceptance" },
    { name: "Lead-accepted subtask whose parent is accepted", task: { parent_task_id: "parent", closed_by: null }, parentAcceptance: "accepted", text: "Human review settled with the parent job's acceptance" },
    { name: "Lead-accepted subtask whose parent is open", task: { parent_task_id: "parent", closed_by: null }, parentAcceptance: "pending", text: "Human review deferred to the parent job. Review it when the job is ready for acceptance." },
    { name: "Lead-accepted subtask with no parent context", task: { parent_task_id: "parent", closed_by: null }, text: "Human review deferred to the parent job. Its acceptance is not confirmed here." },
  ];
  it.each(cases)("renders the actual responsibility for an $name", ({ task, parentAcceptance, text }) => {
    const input = props();
    input.task = { ...input.task, state: "done", acceptance: "accepted", ...task };
    input.parentAcceptance = parentAcceptance;
    act(() => root.render(createElement(TaskView, input)));
    const result = verification("person");
    expect(paragraphs(result)).toContain(text);
    expect(result.textContent).not.toContain("Waiting for you");
    expect(result.textContent).toContain("verified");
    expect(region("Verification").querySelector('button')).toBeNull();
    expect(host.querySelector('[aria-label="Ready for you"]')).toBeNull();
    expect(verification("agent").textContent).toContain("contradicted");
  });

  it("does not invent a passing review when a person accepted with unverified evidence", () => {
    const input = props();
    input.task = { ...input.task, state: "done", acceptance: "accepted", closed_by: "person" };
    input.review = { ...input.review!, findings: [{ criterion_id: "person", status: "unverified" }] };
    act(() => root.render(createElement(TaskView, input)));
    expect(verification("person").textContent).toContain("unverified");
    expect(paragraphs(verification("person"))).toContain("Human review settled with acceptance");
  });

  it("updates a deferred check when the parent is accepted without resetting feedback or changing a finding", () => {
    const input = props();
    input.task = { ...input.task, state: "done", acceptance: "accepted", parent_task_id: "parent", closed_by: null };
    act(() => root.render(createElement(TaskView, { ...input, parentAcceptance: "pending" })));
    const feedback = host.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(feedback, "Keep these notes for later.");
      feedback.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => root.render(createElement(TaskView, { ...input, parentAcceptance: "accepted" })));
    expect(host.querySelector("textarea")).toBe(feedback);
    expect(feedback.value).toBe("Keep these notes for later.");
    expect(paragraphs(verification("person"))).toContain("Human review settled with the parent job's acceptance");
    expect(verification("agent").textContent).toContain("contradicted");
    expect(input.onMessage).not.toHaveBeenCalled();
  });

  it.each(["done", "failed", "cancelled"] as const)("does not describe a %s task without acceptance as actively waiting for the person", (state) => {
    const input = props();
    input.task = { ...input.task, state, acceptance: "rejected" };
    act(() => root.render(createElement(TaskView, input)));
    expect(paragraphs(verification("person"))).toContain("Human review was not settled by acceptance");
    expect(verification("person").textContent).not.toContain("Waiting for you");
  });
});
