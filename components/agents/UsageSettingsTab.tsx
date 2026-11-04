import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";
import { useAgentTasks } from "@/lib/agentTasks";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";
import { aggregateUsage, loadUsageRuns, periodStart, type UsageRun } from "@/lib/agentUsage";
import { UsagePanel, type UsagePeriod } from "@/components/agents/settings/UsagePanel";

type Price = Parameters<typeof aggregateUsage>[2][number];
const EMPTY = { agents: [], models: [], totals: { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } };

export function UsageSettingsTab() {
  const currentWorkspace = useStore((s) => s.syncWorkspaceId);
  const { workspaceId, status, error, load } = useAgentsStore();
  useEffect(() => {
    if (status === "idle" || (currentWorkspace && currentWorkspace !== workspaceId && status === "ready")) {
      void load(currentWorkspace);
    }
  }, [currentWorkspace, workspaceId, status, load]);
  const unavailable = status === "unavailable" || status === "signed_out";
  if (unavailable || status === "error" || !workspaceId || (currentWorkspace && currentWorkspace !== workspaceId)) {
    return <UsagePanel {...EMPTY} period="month" onPeriodChange={() => {}} onRefresh={() => { void load(currentWorkspace); }}
      state={unavailable || status === "error" ? "error" : "loading"}
      errorMessage={error ?? (status === "signed_out" ? "Sign in to view usage." : "Usage needs a cloud connection.")} />;
  }
  // A workspace change discards its previous results and pending requests immediately.
  return <WorkspaceUsage key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceUsage({ workspaceId }: { workspaceId: string }) {
  const agents = useAgentsStore((s) => s.agents);
  const liveRuns = useAgentTasks((s) => s.runs);
  const liveWorkspace = useAgentTasks((s) => s.workspaceId);
  const subscribe = useAgentTasks((s) => s.subscribe);
  const [selection, setSelection] = useState<{ period: UsagePeriod; since: string }>(() => ({ period: "month", since: periodStart("month") }));
  const { period, since } = selection;
  const prices = useRef<Price[] | null>(null);
  const [result, setResult] = useState<{ runs: UsageRun[]; prices: Price[]; state: "loading" | "ready" | "error"; error?: string }>({
    runs: [], prices: [], state: "loading",
  });

  useEffect(() => subscribe(workspaceId), [subscribe, workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const client = getAgentClient();
    async function load() {
      setResult((previous) => ({ ...previous, state: "loading", error: undefined }));
      try {
        if (!client) throw new Error("Usage needs a cloud connection.");
        const [runs, priceResult] = await Promise.all([
          loadUsageRuns(client, workspaceId, since, signal),
          prices.current ? Promise.resolve({ data: prices.current, error: null })
            : client.from("model_prices").select("model,input_usd_per_mtok,output_usd_per_mtok,usd_per_minute").abortSignal(signal),
        ]);
        if (signal.aborted) return;
        if (priceResult.error) throw priceResult.error;
        const loadedPrices = (priceResult.data ?? []) as Price[];
        prices.current = loadedPrices;
        setResult({ runs, prices: loadedPrices, state: "ready" });
      } catch (error) {
        if (!signal.aborted) setResult((previous) => ({ ...previous, state: "error", error: agentErrorMessage(error) }));
      }
    }
    void load();
    return () => controller.abort();
  }, [workspaceId, since, selection]);

  const usage = useMemo(() => {
    const merged = new Map(result.runs.map((run) => [run.id, run]));
    if (liveWorkspace === workspaceId) {
      for (const run of Object.values(liveRuns)) {
        if (Date.parse(run.started_at) >= Date.parse(since)) merged.set(run.id, { ...run,
          input_tokens: Number(run.input_tokens), output_tokens: Number(run.output_tokens), cost_usd: Number(run.cost_usd) });
      }
    }
    return aggregateUsage([...merged.values()], agents.map((agent) => ({
      id: agent.id, name: agent.name, harness: typeof agent.connection.harness === "string" ? agent.connection.harness : null,
      monthlyBudgetUsd: agent.monthly_budget_usd == null ? null : Number(agent.monthly_budget_usd),
      enabled: agent.status === "enabled" && agent.revoked_at === null,
    })), result.prices);
  }, [result.runs, result.prices, liveRuns, liveWorkspace, workspaceId, since, agents]);

  const selectPeriod = (next: UsagePeriod) => setSelection({ period: next, since: periodStart(next) });
  return <UsagePanel {...usage} period={period} onPeriodChange={selectPeriod} state={result.state}
    errorMessage={result.error} onRefresh={() => selectPeriod(period)} />;
}
