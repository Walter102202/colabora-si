import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectStep, loadConnections, pickConnection, shouldShowConnect, type ConnectionRow } from "@/lib/agentConnect";

const agent = { id: "a", is_platform: false, revoked_at: null };
const row: ConnectionRow = { agent_id: "a", page_id: "p", approved_at: "2026-11-01T10:00:00Z", verified_at: null, created_at: "2026-11-01T09:59:00Z" };

describe("connect visibility", () => {
  it.each([
    [true, false, [], [], true],
    [false, false, [], [], false],
    [true, true, [], [], false],
    [true, false, [agent], [], false],
    [true, false, [agent], [row], true],
    [true, false, [agent], [{ ...row, verified_at: row.approved_at }], false],
    [true, false, [{ ...agent, is_platform: true }], [], true],
    [true, false, [{ ...agent, revoked_at: row.approved_at }], [{ ...row, verified_at: row.approved_at }], true],
  ])("canConnect=%s skipped=%s agents=%j rows=%j", (canConnect, skipped, agents, connections, expected) => {
    expect(shouldShowConnect({ canConnect, skipped, agents, connections })).toBe(expected);
  });
  it("matches explicit agent identities and ignores unrelated approvals", () => {
    expect(pickConnection([row], { agentId: "a", startedAt: Date.now() })).toBe(row);
    expect(pickConnection([row], { agentId: "b", startedAt: 0 })).toBeNull();
  });
  it("picks the latest approval inside the one-minute tolerance", () => {
    const newer = { ...row, agent_id: "b", approved_at: "2026-11-01T10:00:30Z" };
    expect(pickConnection([newer, row], { startedAt: Date.parse("2026-11-01T10:01:00Z") })).toBe(newer);
    expect(pickConnection([row], { startedAt: Date.parse("2026-11-01T10:01:00Z") })).toBe(row);
    expect(pickConnection([row, { ...row, approved_at: null }], { startedAt: Date.parse("2026-11-01T10:01:01Z") })).toBeNull();
  });
  it.each([
    [null, null, "setup"], [{ copied: false }, null, "setup"], [{ copied: true }, null, "waiting"],
    [{ copied: true }, { ...row, approved_at: null }, "waiting"], [null, row, "approved"],
    [null, { ...row, verified_at: row.approved_at }, "connected"],
  ])("connection step %#", (attempt, connection, expected) => expect(connectStep(attempt, connection)).toBe(expected));
  it("loads workspace-scoped connections and propagates failures", async () => {
    const eq = vi.fn().mockResolvedValue({ data: [row], error: null });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    const client = { from } as unknown as SupabaseClient;
    expect(await loadConnections(client, "w")).toEqual([row]);
    expect(from).toHaveBeenCalledWith("agent_connections");
    expect(eq).toHaveBeenCalledWith("workspace_id", "w");
    eq.mockResolvedValue({ data: null, error: new Error("offline") });
    await expect(loadConnections(client, "w")).rejects.toThrow("offline");
  });
});
