"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchAgentMetrics } from "@/lib/agentActions";
import type { Metric } from "@/lib/agentMetrics";
import { MetricsList } from "@/components/agents/panel";
import { useStore } from "@/lib/store";
import { useAgentsStore, type AgentRow } from "@/lib/agentsStore";
import { formatRelative } from "@/lib/utils";
import { ConnectionSnippet } from "@/components/agents/settings/ConnectionSnippet";
import { TokenReveal } from "@/components/agents/settings/TokenReveal";

const SCOPES = ["read", "write", "comment"] as const;

// What will happen when the person presses each control (§ copies, in English).
const WHAT = {
  pause: "Stops reading and writing on its next call. Open connections can take up to 1 hour to drop.",
  disable: "Loses access to everything. Its open tasks are left without an agent.",
  revokeToken: "The harness stops authenticating. An already exchanged token stays valid for up to 1 hour.",
};

export function AgentDetail({ agent, onBack }: { agent: AgentRow; onBack: () => void }) {
  const pages = useStore((s) => s.pages);
  // Select the raw arrays: a selector that filters returns a new array on every call and re-renders forever.
  const allGrants = useAgentsStore((s) => s.grants);
  const allTokens = useAgentsStore((s) => s.tokens);
  const grants = useMemo(() => allGrants.filter((g) => g.agent_id === agent.id), [allGrants, agent.id]);
  const tokens = useMemo(() => allTokens.filter((t) => t.agent_id === agent.id), [allTokens, agent.id]);
  const { issueToken, revokeToken, grantPage, revokeGrant, setPaused, revokeAgent } = useAgentsStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [pageId, setPageId] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [results, setResults] = useState<Metric[] | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchAgentMetrics(agent.id).then((result) => { if (alive) setResults(result.metrics); }, () => { if (alive) setResults(null); });
    return () => { alive = false; };
  }, [agent.id]);

  const harness = typeof agent.connection.harness === "string" ? agent.connection.harness : "claude-code";
  const pageList = Object.values(pages).filter((p) => !p.isDeleted);
  const titleOf = (id: string) => {
    const p = pages[id];
    return p ? `${p.icon ? p.icon + " " : ""}${p.title || "Untitled"}` : id;
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5 text-sm">
      <div className="flex items-center gap-2">
        <button type="button" className="rounded px-2 py-1 text-text-secondary hover:bg-bg-secondary" onClick={onBack}>← Agents</button>
        <h3 className="text-base font-semibold">{agent.name}</h3>
        <span className="text-xs text-text-tertiary">{agent.role === "lead" ? "Lead" : "Worker"} · {agent.status}</span>
      </div>

      {error && <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-400">{error}</p>}

      <section className="space-y-2">
        <h4 className="font-medium">Access</h4>
        {grants.length === 0 && <p className="text-text-tertiary">This agent cannot read anything yet.</p>}
        <ul className="space-y-1">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-bg-secondary">
              <span className="min-w-0 flex-1 truncate">{titleOf(g.page_id)}</span>
              <span className="text-xs text-text-secondary">{g.scopes.join(", ")}{g.inherit ? " · with sub-pages" : ""}</span>
              <button type="button" className="text-xs text-text-secondary hover:text-text" disabled={busy !== null} onClick={() => run("grant-" + g.id, () => revokeGrant(g.id))}>Remove</button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded border border-border bg-bg px-2 py-1" value={pageId} onChange={(e) => setPageId(e.target.value)}>
            <option value="">Choose a page…</option>
            {pageList.map((p) => <option key={p.id} value={p.id}>{titleOf(p.id)}</option>)}
          </select>
          {SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
              {s}
            </label>
          ))}
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50"
            disabled={!pageId || scopes.length === 0 || busy !== null}
            onClick={() => run("grant", () => grantPage(agent.id, pageId, scopes, true))}
          >
            Give access
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="font-medium">Tokens</h4>
        {newToken && <TokenReveal token={newToken} onDone={() => setNewToken(null)} />}
        <ul className="space-y-1">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-bg-secondary">
              <code className="font-mono text-xs">{t.token_prefix}…</code>
              <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                {t.name} · {t.last_used_at ? `used ${formatRelative(Date.parse(t.last_used_at))}` : "never used"}
              </span>
              <button type="button" className="text-xs text-text-secondary hover:text-text" title={WHAT.revokeToken} disabled={busy !== null} onClick={() => run("tok-" + t.id, () => revokeToken(t.id))}>Revoke</button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50"
          disabled={busy !== null || agent.status === "disabled"}
          onClick={() => run("token", async () => setNewToken(await issueToken(agent.id, "token " + (tokens.length + 1))))}
        >
          New token
        </button>
      </section>

      <section className="space-y-2">
        <h4 className="font-medium">Connection</h4>
        <ConnectionSnippet harness={harness} />
      </section>

      {results && <MetricsList title="Results (last 30 days)" metrics={results} />}

      <section className="space-y-2">
        <h4 className="font-medium">Controls</h4>
        <div className="flex flex-wrap gap-2">
          {agent.status !== "disabled" && (
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50"
              title={WHAT.pause}
              disabled={busy !== null}
              onClick={() => run("pause", () => setPaused(agent.id, agent.status !== "paused"))}
            >
              {agent.status === "paused" ? "Resume agent" : "Pause agent"}
            </button>
          )}
          {agent.status !== "disabled" && !confirmDisable && (
            <button type="button" className="rounded border border-border px-2 py-1 text-xs text-red-700 hover:bg-bg-secondary dark:text-red-400" title={WHAT.disable} disabled={busy !== null} onClick={() => setConfirmDisable(true)}>
              Disable agent
            </button>
          )}
          {confirmDisable && (
            <span className="flex items-center gap-2 text-xs">
              <span>{WHAT.disable}</span>
              <button type="button" className="rounded bg-red-600 px-2 py-1 text-white" disabled={busy !== null} onClick={() => run("disable", () => revokeAgent(agent.id, "disabled from settings"))}>Disable</button>
              <button type="button" className="rounded px-2 py-1 hover:bg-bg-secondary" onClick={() => setConfirmDisable(false)}>Keep</button>
            </span>
          )}
        </div>
        <p className="text-xs text-text-tertiary">{agent.status === "paused" ? "This agent is paused. It cannot read or write until you resume it." : WHAT.pause}</p>
      </section>
    </div>
  );
}
