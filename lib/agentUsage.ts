import type { SupabaseClient } from "@supabase/supabase-js";

// Temporary shared view contracts until feat/usage-views is integrated.
export type UsagePeriod = "month" | "30d";
export interface UsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
export interface UsageAgentRow extends UsageTotals {
  agentId: string;
  name: string;
  harness: string | null;
  estimated: boolean;
  monthlyBudgetUsd: number | null;
  models: string[];
  lastRunAt: string | null;
}
export interface UsageModelRow extends UsageTotals {
  model: string;
  inputUsdPerMtok: number | null;
  outputUsdPerMtok: number | null;
  usdPerMinute: number | null;
}
export interface UsageRun {
  id: string;
  agent_id: string;
  harness: string;
  model: string | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_kind: "measured" | "estimated" | "unknown";
  started_at: string;
  ended_at: string | null;
}

export function periodStart(period: UsagePeriod, now = new Date()): string {
  return (period === "month"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    : new Date(now.getTime() - 30 * 86400000)).toISOString();
}

const emptyTotals = (): UsageTotals => ({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
// Costs are stored as numeric(12,6); accumulate integer microdollars to avoid drift.
function addRun(total: UsageTotals, run: UsageRun): void {
  total.runs++;
  total.inputTokens += run.input_tokens;
  total.outputTokens += run.output_tokens;
  total.costUsd = (Math.round(total.costUsd * 1e6) + Math.round(run.cost_usd * 1e6)) / 1e6;
}
function compareNames(a: string, b: string): number {
  return Number(a.toLowerCase() === "unknown" || a === "Unknown agent")
    - Number(b.toLowerCase() === "unknown" || b === "Unknown agent") || a.localeCompare(b);
}

export function aggregateUsage(
  runs: UsageRun[],
  agents: { id: string; name: string; harness: string | null; monthlyBudgetUsd: number | null; enabled?: boolean }[],
  prices: { model: string; input_usd_per_mtok: number; output_usd_per_mtok: number; usd_per_minute?: number | null }[],
): { agents: UsageAgentRow[]; models: UsageModelRow[]; totals: UsageTotals } {
  const metadata = new Map(agents.map((agent) => [agent.id, agent]));
  const agentRows = new Map<string, UsageAgentRow>();
  const modelRows = new Map<string, UsageModelRow>();
  const modelCosts = new Map<string, Map<string, number>>();
  const priceMap = new Map(prices.map((price) => [price.model, price]));
  const totals = emptyTotals();
  function agentRow(id: string): UsageAgentRow {
    let row = agentRows.get(id);
    if (!row) {
      const agent = metadata.get(id);
      row = { ...emptyTotals(), agentId: id, name: agent?.name ?? "Unknown agent",
        harness: agent?.harness ?? null, monthlyBudgetUsd: agent?.monthlyBudgetUsd ?? null,
        estimated: false, models: [], lastRunAt: null };
      agentRows.set(id, row);
      modelCosts.set(id, new Map());
    }
    return row;
  }
  for (const agent of agents) if (agent.enabled !== false) agentRow(agent.id);
  for (const run of runs) {
    const agent = agentRow(run.agent_id);
    const model = run.model ?? "unknown";
    let modelRow = modelRows.get(model);
    if (!modelRow) {
      const price = run.model === null ? undefined : priceMap.get(model);
      modelRow = { ...emptyTotals(), model,
        inputUsdPerMtok: price ? Number(price.input_usd_per_mtok) : null,
        outputUsdPerMtok: price ? Number(price.output_usd_per_mtok) : null,
        usdPerMinute: price?.usd_per_minute == null ? null : Number(price.usd_per_minute) };
      modelRows.set(model, modelRow);
    }
    addRun(totals, run);
    addRun(agent, run);
    addRun(modelRow, run);
    agent.estimated ||= run.cost_kind !== "measured" && run.cost_usd > 0;
    if (agent.lastRunAt === null || Date.parse(run.started_at) > Date.parse(agent.lastRunAt)) {
      agent.lastRunAt = run.started_at;
      agent.harness = metadata.get(run.agent_id)?.harness ?? run.harness;
    }
    const costs = modelCosts.get(run.agent_id)!;
    costs.set(model, (costs.get(model) ?? 0) + Math.round(run.cost_usd * 1e6));
  }
  for (const [id, row] of agentRows) {
    row.models = [...modelCosts.get(id)!].sort(([a, ac], [b, bc]) => bc - ac || compareNames(a, b)).map(([model]) => model);
  }
  return {
    agents: [...agentRows.values()].sort((a, b) => b.costUsd - a.costUsd || compareNames(a.name, b.name)),
    models: [...modelRows.values()].sort((a, b) => b.costUsd - a.costUsd || compareNames(a.model, b.model)),
    totals,
  };
}

export async function loadUsageRuns(
  client: SupabaseClient, workspaceId: string, since: string, signal?: AbortSignal,
): Promise<UsageRun[]> {
  const runs: UsageRun[] = [];
  for (let from = 0; ; from += 1000) {
    signal?.throwIfAborted();
    let query = client.from("agent_runs")
      .select("id,agent_id,harness,model,status,input_tokens,output_tokens,cost_usd,cost_kind,started_at,ended_at")
      .eq("workspace_id", workspaceId).gte("started_at", since)
      .order("started_at").order("id").range(from, from + 999);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    signal?.throwIfAborted();
    if (error) throw error;
    const page = (data ?? []) as UsageRun[];
    for (const run of page) runs.push({ ...run, input_tokens: Number(run.input_tokens),
      output_tokens: Number(run.output_tokens), cost_usd: Number(run.cost_usd) });
    if (page.length < 1000) return runs;
  }
}
