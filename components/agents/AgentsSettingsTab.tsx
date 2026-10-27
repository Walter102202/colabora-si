"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { useAgentsStore, type NewAgentInput } from "@/lib/agentsStore";
import { AgentList } from "@/components/agents/settings/AgentList";
import { NewAgentWizard } from "@/components/agents/settings/NewAgentWizard";
import { AgentDetail } from "@/components/agents/settings/AgentDetail";
import { TokenReveal } from "@/components/agents/settings/TokenReveal";

type View = { kind: "list" } | { kind: "new" } | { kind: "detail"; id: string };

// Agent layer plug. Mounted as the "Agents" tab of the settings modal, after
// "Members": the list of registered agents, the wizard that creates one
// (identity, access, connection, limits), and the per-agent detail.
export function AgentsSettingsTab() {
  const syncWorkspaceId = useStore((s) => s.syncWorkspaceId);
  const { status, error, agents, load, createAgent } = useAgentsStore();
  const [view, setView] = useState<View>({ kind: "list" });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    void load(syncWorkspaceId);
  }, [load, syncWorkspaceId]);

  if (status === "unavailable") return <p className="text-sm text-text-secondary">Agents need the cloud. Configure a backend to register them.</p>;
  if (status === "signed_out") return <p className="text-sm text-text-secondary">Sign in to manage agents.</p>;
  if (status === "idle" || status === "loading") {
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
        <AgentDetail agent={detailAgent} onBack={() => setView({ kind: "list" })} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">Agents work on the pages you give them access to and show up as authors.</p>
        <button type="button" className="shrink-0 rounded bg-accent px-3 py-1 text-sm text-white" onClick={() => setView({ kind: "new" })}>New agent</button>
      </div>
      <AgentList agents={agents} onOpen={(id) => setView({ kind: "detail", id })} />
    </div>
  );
}
