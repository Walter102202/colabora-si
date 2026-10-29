// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTONOMY_HELP, autonomyLine, type AutonomyPolicy, type TaskAutonomy } from "@/lib/agentAutonomy";
import { agentErrorMessage } from "@/lib/agentClient";
import { TaskView } from "@/components/agents/panel";
import { AutonomySettings, AutonomySettingsView } from "@/components/agents/settings/AutonomySettings";
import { cardDataFrom, type TaskCardData } from "@/lib/agentCard";
import { mockCard } from "@/components/agents/card/mock";
import { Card } from "@/components/agents/card/Card";

const balanced: TaskAutonomy = { level: "balanced", requested: null, source: "workspace", workspace_level: "balanced", auto_approved: ["publish_page"], require_approval: [] };
const policy: AutonomyPolicy = { level: "ask", updated_at: null, updated_by: null, can_edit: true, presets: { ask: [], balanced: ["publish_page"], autonomous: ["publish_page", "send_email"] } };
const noop = async () => {};

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/agentClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentClient")>()),
  getAgentClient: () => ({ rpc }),
}));

// A promise the test settles by hand, to hold a call open.
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("autonomyLine", () => {
  it("says the level, where it comes from and what runs on its own", () => {
    expect(autonomyLine(balanced)).toBe("Autonomy: Balanced (workspace default); runs on its own: publish_page.");
    expect(autonomyLine({ ...balanced, level: "ask", source: "parent", auto_approved: [] }))
      .toBe("Autonomy: Ask first (limited by the parent task); asks before every outside action.");
    expect(autonomyLine({ ...balanced, level: "autonomous", requested: "autonomous", source: "task", auto_approved: ["publish_page", "send_email"] }))
      .toBe("Autonomy: Autonomous (set on this task); runs on its own: publish_page, send_email.");
    expect(autonomyLine(null)).toBeNull();
  });
  it("says when the workspace holds a task below the level set on it", () => {
    expect(autonomyLine({ ...balanced, level: "ask", requested: "autonomous", source: "workspace", workspace_level: "ask", auto_approved: [] }))
      .toBe("Autonomy: Ask first (limited by the workspace); asks before every outside action.");
  });
  it("Ask first says that a preapproval in the brief still counts", () => {
    expect(AUTONOMY_HELP.ask).toBe("Agents ask before every action outside the workspace, unless the task's brief preapproves it.");
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
  it("stays usable from the keyboard while a change saves, and then sends only the latest choice", async () => {
    const calls: (string | null)[] = [];
    const pending: ReturnType<typeof deferred<void>>[] = [];
    const set = vi.fn((level: string | null) => { calls.push(level); const d = deferred<void>(); pending.push(d); return d.promise; });
    act(() => root.render(view({ autonomy: balanced, onSetAutonomy: set })));
    const select = container.querySelector('select[aria-label="Autonomy for this task"]') as HTMLSelectElement;
    const change = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    select.focus();
    change("ask");
    change("balanced");
    change("autonomous");
    expect(calls).toEqual(["ask"]);
    expect(select.disabled).toBe(false);
    expect(select.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(select);
    expect(select.value).toBe("autonomous");
    await act(async () => pending[0].resolve());
    expect(calls).toEqual(["ask", "autonomous"]);
    await act(async () => pending[1].resolve());
    expect(calls).toEqual(["ask", "autonomous"]);
    expect(select.getAttribute("aria-busy")).toBe("false");
  });
  it("a change that fails says why and shows the saved level again", async () => {
    act(() => root.render(view({ autonomy: balanced, onSetAutonomy: vi.fn(async () => { throw new Error("Only a workspace owner can do that."); }) })));
    const select = container.querySelector('select[aria-label="Autonomy for this task"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "autonomous");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Only a workspace owner can do that.");
    expect(select.value).toBe("");
    expect(select.getAttribute("aria-busy")).toBe("false");
  });
  it("is disabled with the reason for anyone who cannot change it", () => {
    act(() => root.render(view({ autonomy: { ...balanced, can_edit: false }, onSetAutonomy: vi.fn(noop) })));
    const select = container.querySelector('select[aria-label="Autonomy for this task"]') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    const note = document.getElementById(select.getAttribute("aria-describedby")!);
    expect(note?.textContent).toBe("Only a workspace owner can change this.");
    act(() => root.render(view({ autonomy: { ...balanced, can_edit: true }, onSetAutonomy: vi.fn(noop) })));
    expect((container.querySelector('select[aria-label="Autonomy for this task"]') as HTMLSelectElement).disabled).toBe(false);
  });
  it("is read-only where no callback is given, as in the chat card", () => {
    act(() => root.render(view({ autonomy: balanced })));
    expect(container.textContent).toContain("Autonomy: Balanced");
    expect(container.querySelector('select[aria-label="Autonomy for this task"]')).toBeNull();
  });
});

describe("autonomy in the chat card", () => {
  it("keeps the line after a decision, whose refreshed card does not read the autonomy", async () => {
    const initial = mockCard("approval") as TaskCardData;
    const refreshed: TaskCardData = { ...initial, task: { ...initial.task, state: "working", waiting_on: null }, approval: null };
    delete refreshed.autonomy;
    const callTool = vi.fn(async () => ({ structuredContent: { status: "decided", ...refreshed } }));
    act(() => root.render(createElement(Card, { initial, actions: { callTool, openLink: () => {} } })));
    expect(container.textContent).toContain("Autonomy: Balanced (workspace default)");
    const approve = [...container.querySelectorAll("button")].find((b) => b.textContent === "Approve")!;
    await act(async () => approve.click());
    expect(callTool).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Send the summary to the ops mailbox?");
    expect(container.textContent).toContain("Autonomy: Balanced (workspace default)");
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
    expect(container.textContent).toContain("a preapproval in a task's brief still counts");
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
  it("keeps the focused level usable while a change saves, and then sends only the latest choice", async () => {
    const sets: ReturnType<typeof deferred<{ data: unknown; error: null }>>[] = [];
    rpc.mockReset().mockImplementation((name: string) => {
      if (name === "get_autonomy_policy") return Promise.resolve({ data: policy, error: null });
      const d = deferred<{ data: unknown; error: null }>();
      sets.push(d);
      return d.promise;
    });
    await act(async () => root.render(createElement(AutonomySettings, { workspaceId: "w1" })));
    const radios = [...container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    const fieldset = container.querySelector("fieldset") as HTMLFieldSetElement;
    radios[1].focus();
    act(() => { radios[1].click(); });
    radios[2].focus();
    act(() => { radios[2].click(); });
    expect(rpc.mock.calls.filter(([name]) => name === "set_workspace_autonomy").map(([, args]) => args)).toEqual([{ p_workspace_id: "w1", p_level: "balanced" }]);
    expect(fieldset.disabled).toBe(false);
    expect(fieldset.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(radios[2]);
    expect(radios[2].checked).toBe(true);
    await act(async () => sets[0].resolve({ data: { level: "balanced", previous: "ask" }, error: null }));
    expect(rpc.mock.calls.filter(([name]) => name === "set_workspace_autonomy").map(([, args]) => args.p_level)).toEqual(["balanced", "autonomous"]);
    expect(radios[2].checked).toBe(true);
    await act(async () => sets[1].resolve({ data: { level: "autonomous", previous: "balanced" }, error: null }));
    expect(fieldset.getAttribute("aria-busy")).toBe("false");
    expect(radios[2].checked).toBe(true);
  });
});
