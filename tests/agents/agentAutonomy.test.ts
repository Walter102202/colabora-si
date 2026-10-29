// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autonomyLine, type AutonomyPolicy, type TaskAutonomy } from "@/lib/agentAutonomy";
import { agentErrorMessage } from "@/lib/agentClient";
import { TaskView } from "@/components/agents/panel";
import { AutonomySettingsView } from "@/components/agents/settings/AutonomySettings";
import { cardDataFrom, type TaskCardData } from "@/lib/agentCard";
import { mockCard } from "@/components/agents/card/mock";

const balanced: TaskAutonomy = { level: "balanced", requested: null, source: "workspace", workspace_level: "balanced", auto_approved: ["publish_page"], require_approval: [] };
const policy: AutonomyPolicy = { level: "ask", updated_at: null, updated_by: null, can_edit: true, presets: { ask: [], balanced: ["publish_page"], autonomous: ["publish_page", "send_email"] } };
const noop = async () => {};

describe("autonomyLine", () => {
  it("says the level, where it comes from and what runs on its own", () => {
    expect(autonomyLine(balanced)).toBe("Autonomy: Balanced (workspace default); runs on its own: publish_page.");
    expect(autonomyLine({ ...balanced, level: "ask", source: "parent", auto_approved: [] }))
      .toBe("Autonomy: Ask first (limited by the parent task); asks before every outside action.");
    expect(autonomyLine({ ...balanced, level: "autonomous", requested: "autonomous", source: "task", auto_approved: ["publish_page", "send_email"] }))
      .toBe("Autonomy: Autonomous (set on this task); runs on its own: publish_page, send_email.");
    expect(autonomyLine(null)).toBeNull();
  });
  it("explains owner_required", () => {
    expect(agentErrorMessage({ message: "owner_required" })).toBe("Only a workspace owner can do that.");
  });
});

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

const view = (extra: Record<string, unknown>) => {
  const data = cardDataFrom(mockCard("side-question")) as TaskCardData;
  return createElement(TaskView, {
    ...data, subtasks: [], reviewerName: null, agent: null,
    onMessage: noop, onClose: noop, onDecide: noop, onReview: noop, onOpenTask: () => {}, onOpenPage: () => {}, ...extra,
  });
};

describe("autonomy in the task panel", () => {
  it("shows the line and sets this task's level, or goes back to the workspace default", async () => {
    const set = vi.fn(noop);
    act(() => root.render(view({ autonomy: balanced, onSetAutonomy: set })));
    expect(container.textContent).toContain("Autonomy: Balanced (workspace default)");
    const select = container.querySelector('select[aria-label="Autonomy for this task"]') as HTMLSelectElement;
    const change = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    await change("autonomous");
    await change("");
    expect(set.mock.calls).toEqual([["autonomous"], [null]]);
  });
  it("is read-only where no callback is given, as in the chat card", () => {
    act(() => root.render(view({ autonomy: balanced })));
    expect(container.textContent).toContain("Autonomy: Balanced");
    expect(container.querySelector('select[aria-label="Autonomy for this task"]')).toBeNull();
  });
});

describe("workspace autonomy settings", () => {
  it("offers the three levels with what each one does, and reports the choice", () => {
    const onChange = vi.fn();
    act(() => root.render(createElement(AutonomySettingsView, { policy, busy: false, error: null, onChange })));
    const radios = [...container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["ask", "balanced", "autonomous"]);
    expect(radios[0].checked).toBe(true);
    expect(container.textContent).toContain("payments always ask");
    act(() => { radios[1].click(); });
    expect(onChange).toHaveBeenCalledWith("balanced");
  });
  it("is disabled for anyone who is not an owner", () => {
    act(() => root.render(createElement(AutonomySettingsView, { policy: { ...policy, can_edit: false }, busy: false, error: null, onChange: vi.fn() })));
    expect((container.querySelector("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect(container.textContent).toContain("Only a workspace owner can change this, from the app.");
    act(() => root.render(createElement(AutonomySettingsView, { policy: null, busy: false, error: "Could not load autonomy.", onChange: vi.fn() })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not load autonomy.");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
