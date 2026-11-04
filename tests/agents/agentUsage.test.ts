import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { aggregateUsage, loadUsageRuns, periodStart, type UsageRun } from "@/lib/agentUsage";

const run = (over: Partial<UsageRun> = {}): UsageRun => ({
  id: "r", agent_id: "a", harness: "codex", model: "model-a", status: "done",
  input_tokens: 10, output_tokens: 3, cost_usd: 0.1, cost_kind: "measured",
  started_at: "2026-11-01T12:00:00Z", ended_at: null, ...over,
});
const agent = { id: "a", name: "Alpha", harness: null, monthlyBudgetUsd: 10 };
function fakeClient(pages: unknown[][], afterPage?: () => void, error: unknown = null) {
  let page = 0;
  const query = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) => {
      const data = pages[page++] ?? [];
      afterPage?.();
      return Promise.resolve(resolve({ data, error }));
    },
  };
  const from = vi.fn(() => query);
  return { client: { from } as unknown as SupabaseClient, from, query };
}

describe("usage periods", () => {
  it("uses UTC month boundaries and elapsed days without mutating now", () => {
    const now = new Date("2026-03-01T00:30:00+01:00");
    expect(periodStart("month", now)).toBe("2026-02-01T00:00:00.000Z");
    expect(periodStart("30d", now)).toBe("2026-01-29T23:30:00.000Z");
    expect(now.toISOString()).toBe("2026-02-28T23:30:00.000Z");
  });
});

describe("usage aggregation", () => {
  it("preserves orphan and disabled runs, zero-run enabled agents, prices and newest harness", () => {
    const result = aggregateUsage([
      run({ harness: "newest", started_at: "2026-11-03T00:00:00Z", model: "z-model", cost_kind: "estimated" }),
      run({ model: null, harness: "older" }),
      run({ model: "muse-voice-transcribe-1.0", cost_usd: 0.003 }),
      run({ agent_id: "missing", model: null, cost_usd: 0.2, cost_kind: "unknown" }),
      run({ agent_id: "disabled", cost_usd: 0.01 }),
    ], [agent, { ...agent, id: "zero", name: "Zero" },
      { ...agent, id: "disabled", enabled: false, harness: "configured" },
      { ...agent, id: "hidden", enabled: false }], [
      { model: "muse-voice-transcribe-1.0", input_usd_per_mtok: "0" as unknown as number,
        output_usd_per_mtok: "0" as unknown as number, usd_per_minute: "0.003" as unknown as number },
    ]);
    expect(result.totals).toEqual({ runs: 5, inputTokens: 50, outputTokens: 15, costUsd: 0.413 });
    expect(result.agents.map((a) => a.agentId)).toEqual(["a", "missing", "disabled", "zero"]);
    expect(result.agents[0]).toMatchObject({ harness: "newest", runs: 3, costUsd: 0.203,
      estimated: true, lastRunAt: "2026-11-03T00:00:00Z", models: ["z-model", "unknown", "muse-voice-transcribe-1.0"] });
    expect(result.agents[1]).toMatchObject({ name: "Unknown agent", harness: "codex", monthlyBudgetUsd: null, estimated: true });
    expect(result.agents[2].harness).toBe("configured");
    expect(result.agents[3]).toMatchObject({ runs: 0, costUsd: 0, models: [], lastRunAt: null, estimated: false });
    expect(result.models.find((m) => m.model === "unknown")).toMatchObject({ runs: 2, costUsd: 0.3, inputUsdPerMtok: null });
    expect(result.models.find((m) => m.model === "muse-voice-transcribe-1.0"))
      .toMatchObject({ inputUsdPerMtok: 0, outputUsdPerMtok: 0, usdPerMinute: 0.003 });
    expect(result.agents.reduce((sum, a) => sum + a.runs, 0)).toBe(result.totals.runs);
  });

  it("orders equal costs by name with unknown last and does not mark zero unmeasured cost estimated", () => {
    const result = aggregateUsage([run({ model: null, cost_usd: 0, cost_kind: "unknown" }),
      run({ model: "", cost_usd: 0 }), run({ model: "z", cost_usd: 0 }), run({ model: "a", cost_usd: 0 })], [agent], []);
    expect(result.models.map((m) => m.model)).toEqual(["a", "z", "unknown"]);
    expect(result.models[2].runs).toBe(2);
    expect(result.agents[0].models).toEqual(["a", "z", "unknown"]);
    expect(result.agents[0].estimated).toBe(false);
    expect(aggregateUsage([], [], []).totals).toEqual({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });
});

describe("usage pagination", () => {
  it("loads 1000 + 1000 + 3 rows in stable order, normalizes numeric strings and sums every page", async () => {
    const rows = Array.from({ length: 2003 }, (_, i) => ({ ...run({ id: String(i) }),
      input_tokens: "10", output_tokens: "3", cost_usd: "0.000001" }));
    const { client, from, query } = fakeClient([rows.slice(0, 1000), rows.slice(1000, 2000), rows.slice(2000)]);
    const runs = await loadUsageRuns(client, "workspace", "since");
    expect(runs).toHaveLength(2003);
    expect(from.mock.calls).toEqual(Array.from({ length: 3 }, () => ["agent_runs"]));
    expect(query.range.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(query.order.mock.calls).toEqual(Array.from({ length: 3 }, () => [["started_at"], ["id"]]).flat());
    expect(query.eq.mock.calls).toEqual(Array.from({ length: 3 }, () => ["workspace_id", "workspace"]));
    expect(query.gte.mock.calls).toEqual(Array.from({ length: 3 }, () => ["started_at", "since"]));
    expect(query.select.mock.calls[0][0].split(",").sort()).toEqual(Object.keys(run()).sort());
    expect(aggregateUsage(runs, [agent], []).totals)
      .toEqual({ runs: 2003, inputTokens: 20030, outputTokens: 6009, costUsd: 0.002003 });
  });

  it("aborts between pages and never returns a partial total", async () => {
    const controller = new AbortController();
    const { client, query } = fakeClient([Array.from({ length: 1000 }, () => run())], () => controller.abort());
    await expect(loadUsageRuns(client, "w", "s", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(query.range).toHaveBeenCalledTimes(1);
    expect(query.abortSignal).toHaveBeenCalledWith(controller.signal);
    await expect(loadUsageRuns(client, "w", "s", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(query.range).toHaveBeenCalledTimes(1);
  });

  it("throws a server error and stops on an empty page", async () => {
    const error = { message: "permission denied" };
    await expect(loadUsageRuns(fakeClient([], undefined, error).client, "w", "s")).rejects.toEqual(error);
    const { client, query } = fakeClient([[]]);
    await expect(loadUsageRuns(client, "w", "s")).resolves.toEqual([]);
    expect(query.range).toHaveBeenCalledTimes(1);
  });
});
