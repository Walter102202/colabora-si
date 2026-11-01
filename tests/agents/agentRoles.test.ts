import { describe, expect, it } from "vitest";
import { agentEffect } from "@/lib/agentRoles";
import type { ConnectedRow } from "@/lib/agentConnect";

type RoleRow = Pick<ConnectedRow, "name" | "role" | "autonomy">;
const lead: RoleRow = { name: "Claude Code", role: "lead", autonomy: "balanced" };
const worker: RoleRow = { name: "Codex", role: "worker", autonomy: "autonomous" };

describe("agentEffect", () => {
  it("explains the workspace stop before any agent or Lead level", () => {
    for (const row of [lead, worker]) {
      expect(agentEffect(row, [lead, worker], "ask")).toBe("Stopped: the workspace is at Ask first.");
    }
  });
  it("shows the lowest Lead ceiling, using workspace defaults for unset levels", () => {
    expect(agentEffect(worker, [lead, worker], "autonomous")).toBe("Held to Balanced under Claude Code.");
    const lower: RoleRow = { name: "Muse Code", role: "lead", autonomy: "ask" };
    expect(agentEffect(worker, [lead, lower], "autonomous")).toBe("Held to Ask first under Muse Code.");
    expect(agentEffect(worker, [{ ...lead, autonomy: null }], "balanced")).toBe("Held to Balanced under Claude Code.");
    expect(agentEffect({ ...worker, autonomy: null }, [lead], "autonomous")).toBe("Held to Balanced under Claude Code.");
  });
  it("does not claim a ceiling for Leads, equal or lower Workers, or without a Lead", () => {
    expect(agentEffect(lead, [{ ...lead, autonomy: "ask" }], "autonomous")).toBeNull();
    expect(agentEffect({ ...worker, autonomy: "balanced" }, [lead], "autonomous")).toBeNull();
    expect(agentEffect({ ...worker, autonomy: "ask" }, [lead], "autonomous")).toBeNull();
    expect(agentEffect(worker, [], "balanced")).toBeNull();
  });
});
