"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { useAgentsStore, type NewAgentInput } from "@/lib/agentsStore";
import { AutonomySettings } from "@/components/agents/settings/AutonomySettings";
import { LessonsList } from "@/components/agents/settings/LessonsList";
import { TelegramConnection } from "@/components/agents/settings/TelegramConnection";
import { AgentList } from "@/components/agents/settings/AgentList";
import { ConnectedApps } from "@/components/agents/settings/ConnectedApps";
import { CiConnections } from "@/components/agents/settings/CiConnections";
import { NewAgentWizard } from "@/components/agents/settings/NewAgentWizard";
import { AgentDetail, type AgentUsageSummary } from "@/components/agents/settings/AgentDetail";
import { getAgentClient } from "@/lib/agentClient";
import { loadUsageRuns, periodStart, type UsageRun } from "@/lib/agentUsage";

function summarizeUsage(runs: UsageRun[], agentId: string): AgentUsageSummary {
  const mine = runs.filter((r) => r.agent_id === agentId);
  const last = mine.reduce<UsageRun | null>((best, r) => (!best || Date.parse(r.started_at) > Date.parse(best.started_at) ? r : best), null);
  return {
    runs: mine.length,
    inputTokens: mine.reduce((sum, r) => sum + r.input_tokens, 0),
    outputTokens: mine.reduce((sum, r) => sum + r.output_tokens, 0),
    costUsd: mine.reduce((sum, r) => (Math.round(sum * 1e6) + Math.round(r.cost_usd * 1e6)) / 1e6, 0),
    lastModel: last?.model ?? null,
  };
}
import { TokenReveal } from "@/components/agents/settings/TokenReveal";
import { EnvironmentList } from "@/components/agents/settings/EnvironmentList";
import { CONNECT_URL } from "@/lib/routes";

type View = { kind: "list" } | { kind: "new" } | { kind: "detail"; id: string };

// Agent layer plug. Mounted as the "Agents" tab of the settings modal, after
// "Members": the list of registered agents, the wizard that creates one
// (identity, access, connection, limits), and the per-agent detail.
export function AgentsSettingsTab() {
  const syncWorkspaceId = useStore((s) => s.syncWorkspaceId);
  const { status, error, agents, load, createAgent, enablePlatformAgent } = useAgentsStore();
  const [view, setView] = useState<View>({ kind: "list" });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    void load(syncWorkspaceId);
  }, [load, syncWorkspaceId]);

  const detailId = view.kind === "detail" ? view.id : null;
  const [usage, setUsage] = useState<{ agentId: string; summary: AgentUsageSummary } | null>(null);
  useEffect(() => {
    if (!detailId || !syncWorkspaceId) return;
    const controller = new AbortController();
    const client = getAgentClient();
    if (!client) return;
    loadUsageRuns(client, syncWorkspaceId, periodStart("month"), controller.signal)
      .then((runs) => { if (!controller.signal.aborted) setUsage({ agentId: detailId, summary: summarizeUsage(runs, detailId) }); })
      .catch(() => { if (!controller.signal.aborted) setUsage(null); });
    return () => controller.abort();
  }, [detailId, syncWorkspaceId]);

  if (status === "unavailable") return <p className="text-sm text-text-secondary">Agents need the cloud. Configure a backend to register them.</p>;
  if (status === "signed_out") return <p className="text-sm text-text-secondary">Sign in to manage agents.</p>;
  // Skeleton only before the first load: a refresh after an action must not unmount the detail
  // view, which holds the token shown once.
  if (status === "idle" || (status === "loading" && agents.length === 0)) {
    return <div className="h-16 animate-pulse rounded-md bg-bg-secondary" aria-busy="true" />;
  }
  if (status === "error") {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-text-secondary">Could not load agents: {error}</p>
        <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" onClick={() => load(syncWorkspaceId)}>Retry</button>
      </div>
    );
  }

  const onCreate = async (input: NewAgentInput) => {
    setBusy(true);
    setFormError(null);
    try {
      const res = await createAgent(input);
      if (res.token) setCreated({ id: res.agentId, token: res.token });
      setView({ kind: "detail", id: res.agentId });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onEnablePlatform = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const res = await enablePlatformAgent();
      setCreated({ id: res.agentId, token: res.token });
      setView({ kind: "detail", id: res.agentId });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (view.kind === "new") {
    return (
      <div className="space-y-3">
        <h3 className="text-base font-semibold">New agent</h3>
        {formError && <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-400">{formError}</p>}
        <NewAgentWizard onCancel={() => setView({ kind: "list" })} onCreate={onCreate} busy={busy} />
      </div>
    );
  }

  const detailAgent = view.kind === "detail" ? agents.find((a) => a.id === view.id) : undefined;
  if (view.kind === "detail" && detailAgent) {
    return (
      <div className="space-y-3">
        {created?.id === detailAgent.id && <TokenReveal token={created.token} onDone={() => setCreated(null)} />}
        <AgentDetail agent={detailAgent} onBack={() => setView({ kind: "list" })} usage={usage?.agentId === detailAgent.id ? usage.summary : null} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {formError && <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-400">{formError}</p>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">Agents work on the pages you give them access to and show up as authors.</p>
        {import.meta.env.VITE_TRAMA_MANAGED !== "1" && !agents.some((a) => a.is_platform && !a.revoked_at) && (
          <button type="button" className="shrink-0 rounded border border-border px-3 py-1 text-sm hover:bg-bg-secondary disabled:opacity-50" disabled={busy} onClick={onEnablePlatform}>Enable Trama</button>
        )}
        <button type="button" className="shrink-0 rounded bg-accent px-3 py-1 text-sm text-white" onClick={() => setView({ kind: "new" })}>New agent</button>
      </div>
      <AutonomySettings key={`autonomy-${syncWorkspaceId}`} workspaceId={syncWorkspaceId} />
      <a href={CONNECT_URL} className="inline-block text-sm text-accent hover:underline">Connect an agent</a>
      <AgentList agents={agents} onOpen={(id) => setView({ kind: "detail", id })} />
      {syncWorkspaceId && <LessonsList workspaceId={syncWorkspaceId} />}
      {syncWorkspaceId && <TelegramConnection workspaceId={syncWorkspaceId} />}
      <ConnectedApps />
      <CiConnections key={`ci-${syncWorkspaceId}`} workspaceId={syncWorkspaceId} />
      <EnvironmentList key={`environment-${syncWorkspaceId}`} workspaceId={syncWorkspaceId} />
    </div>
  );
}
