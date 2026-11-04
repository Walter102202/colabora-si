// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsTab } from "@/components/agents/MemorySettingsTab";

const fake = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], enabled: true, error: false, rpc: vi.fn() }));
vi.mock("@/lib/store", () => ({ useStore: (select: (s: object) => unknown) => select({ syncWorkspaceId: "ws" }) }));
vi.mock("@/lib/agentClient", () => ({ agentErrorMessage: (e: Error) => e.message, getAgentClient: () => ({
  from: (table: string) => {
    const q = { select: () => q, eq: () => q, order: () => q, then: (resolve: (v: object) => void) => resolve({ data: table === "person_memories" ? fake.rows : [{ enabled: fake.enabled }], error: null }) };
    return q;
  }, rpc: fake.rpc,
}) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Memory settings", () => {
  it("lists, edits, forgets, confirms bulk deletion and pauses; errors retain the list", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fake.rows = [
      { id: "a", body: "Short answers", source_quote: "I like short answers", status: "active" },
      { id: "b", body: "Old preference", source_quote: "Old words", status: "superseded" },
    ];
    fake.rpc.mockImplementation(async (name, args) => {
      if (fake.error) return { error: new Error("Try again"), data: null };
      if (name === "update_person_memory") fake.rows[0] = { ...fake.rows[0], body: args.p_body };
      if (name === "forget_person_memory") fake.rows = fake.rows.filter((r) => r.id !== args.p_id);
      if (name === "forget_all_person_memories") fake.rows = [];
      if (name === "set_person_memory_enabled") fake.enabled = args.p_enabled;
      return { data: {}, error: null };
    });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const click = async (text: string) => { await act(async () => { (Array.from(host.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLButtonElement).click(); }); };
    try {
      await act(async () => root.render(createElement(MemorySettingsTab)));
      expect(host.querySelector("details")?.textContent).toContain("Old preference");
      expect(host.querySelector("details")?.open).toBe(false);
      expect(host.textContent).toContain('You said: "I like short answers"');
      await click("Edit");
      const input = host.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Concise answers");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Save");
      expect(fake.rpc).toHaveBeenCalledWith("update_person_memory", { p_id: "a", p_body: "Concise answers" });
      fake.error = true;
      await click("Forget");
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Try again");
      expect(host.textContent).toContain("Concise answers");
      fake.error = false;
      await click("Forget");
      expect(host.textContent).not.toContain("Concise answers");
      const confirm = vi.fn(() => false);
      vi.stubGlobal("confirm", confirm);
      await click("Forget everything");
      expect(fake.rpc.mock.calls.filter(([name]) => name === "forget_all_person_memories")).toHaveLength(0);
      expect(confirm).toHaveBeenCalledWith("Forget everything Trama remembers about you in this workspace? This can't be undone.");
      confirm.mockReturnValue(true);
      await click("Forget everything");
      expect(host.textContent).toContain("Nothing yet.");
      await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      expect(fake.rpc).toHaveBeenCalledWith("set_person_memory_enabled", { p_workspace_id: "ws", p_enabled: false });
      expect(host.querySelector('input')?.closest("label")?.textContent).toContain("Remember things I tell Trama");
    } finally {
      await act(async () => root.unmount()); host.remove(); fake.error = false;
    }
  });
});
