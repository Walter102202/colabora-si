// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewAgentInput } from "@/lib/agentsStore";

vi.mock("@/lib/store", () => ({ useStore: (sel: (s: { pages: Record<string, never> }) => unknown) => sel({ pages: {} }) }));
vi.mock("@/lib/agentsStore", async (orig) => ({ ...(await orig<object>()), mcpUrls: () => ({ mcpUrl: "https://abc.supabase.co/functions/v1/mcp", tokenUrl: "https://abc.supabase.co/functions/v1/agent-token" }) }));
const { NewAgentWizard } = await import("@/components/agents/settings/NewAgentWizard");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const click = (text: string) => {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`no button ${text}`);
  act(() => button.click());
};
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("NewAgentWizard", () => {
  it("creates an agent in three steps: pick the harness, paste the snippet, done", () => {
    const created: NewAgentInput[] = [];
    act(() => root.render(createElement(NewAgentWizard, { onCancel: () => {}, onCreate: (i: NewAgentInput) => void created.push(i), busy: false })));
    expect([...container.querySelectorAll("ol li")].map((li) => li.textContent)).toEqual(["1. Harness", "2. Paste", "3. Done"]);
    const name = container.querySelector("input") as HTMLInputElement;
    expect(document.activeElement).toBe(name);
    type(name, "Codex worker");
    (container.querySelector("select") as HTMLSelectElement).value = "codex";
    act(() => container.querySelector("select")!.dispatchEvent(new Event("change", { bubbles: true })));
    click("Next");
    expect(container.querySelector("pre")?.textContent).toContain("[mcp_servers.colabora]");
    click("Next");
    expect(container.textContent).toContain("Codex worker");
    click("Create agent");
    expect(created).toEqual([{
      name: "Codex worker", kind: "acp_local", role: "worker",
      capabilities: { start: false, continue: false, cancel: false, events: false, approval: true, cost: false, files: false, resume: true },
      monthly_budget_usd: null, rate_limit_per_min: 120, grants: [], harness: "codex",
    }]);
  });
  it("does not advance without a name", () => {
    act(() => root.render(createElement(NewAgentWizard, { onCancel: () => {}, onCreate: () => {}, busy: false })));
    expect((container.querySelector("button[disabled]") as HTMLButtonElement | null)?.textContent).toBe("Next");
  });
  it("creates chat harnesses without resume", () => {
    const created: NewAgentInput[] = [];
    act(() => root.render(createElement(NewAgentWizard, { onCancel: () => {}, onCreate: (input: NewAgentInput) => void created.push(input), busy: false })));
    type(container.querySelector("input")!, "Chat agent");
    (container.querySelector("select") as HTMLSelectElement).value = "claude-ai";
    act(() => container.querySelector("select")!.dispatchEvent(new Event("change", { bubbles: true })));
    click("Next"); click("Next"); click("Create agent");
    expect(created[0].capabilities.resume).toBe(false);
  });
});
