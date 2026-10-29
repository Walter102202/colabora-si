"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { HARNESS_SNIPPETS } from "@/lib/agentSnippets";
import type { AgentKind, AgentRole, NewAgentInput } from "@/lib/agentsStore";
import { ConnectionSnippet } from "@/components/agents/settings/ConnectionSnippet";

const STEPS = ["Identity", "Access", "Connection", "Limits"] as const;
const CAPABILITIES = ["start", "continue", "cancel", "events", "approval", "cost", "files"] as const;
const SCOPES = ["read", "write", "comment"] as const;

const HARNESS_KIND: Record<string, AgentKind> = {
  "claude-code": "acp_local",
  codex: "acp_local",
  "claude-ai": "mcp_client",
  chatgpt: "mcp_client",
  cursor: "acp_local",
  "gemini-cli": "acp_local",
  agent: "webhook",
};

export function NewAgentWizard({ onCancel, onCreate, busy }: { onCancel: () => void; onCreate: (input: NewAgentInput) => void; busy: boolean }) {
  const pages = useStore((s) => s.pages);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [role, setRole] = useState<AgentRole>("worker");
  const [harness, setHarness] = useState<string>(HARNESS_SNIPPETS[0].id);
  const [grants, setGrants] = useState<Record<string, { scopes: string[]; inherit: boolean }>>({});
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({ start: false, continue: false, cancel: false, events: false, approval: true, cost: false, files: false });
  const [budget, setBudget] = useState<string>("");
  const [rate, setRate] = useState<number>(120);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step === 0) nameRef.current?.focus();
  }, [step]);

  const roots = Object.values(pages).filter((p) => !p.isDeleted).sort((a, b) => a.updatedAt - b.updatedAt);
  const canNext = step !== 0 || name.trim().length > 0;

  const toggleScope = (pageId: string, scope: string) => {
    setGrants((g) => {
      const cur = g[pageId] ?? { scopes: [], inherit: true };
      const scopes = cur.scopes.includes(scope) ? cur.scopes.filter((s) => s !== scope) : [...cur.scopes, scope];
      const next = { ...g };
      if (scopes.length === 0) delete next[pageId];
      else next[pageId] = { ...cur, scopes };
      return next;
    });
  };

  const submit = () => {
    onCreate({
      name: name.trim(),
      kind: HARNESS_KIND[harness] ?? "acp_local",
      role,
      capabilities,
      monthly_budget_usd: budget.trim() === "" ? null : Number(budget),
      rate_limit_per_min: rate,
      grants: Object.entries(grants).map(([pageId, g]) => ({ pageId, scopes: g.scopes, inherit: g.inherit })),
      harness,
    });
  };

  return (
    <div className="space-y-4 text-sm">
      <ol className="flex gap-3 text-xs text-text-tertiary">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? "font-medium text-text" : ""}>{i + 1}. {s}</li>
        ))}
      </ol>

      {step === 0 && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-text-secondary">Name</span>
            <input
              className="mt-1 w-full rounded border border-border bg-bg px-2 py-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Codex worker"
              maxLength={80}
              ref={nameRef}
            />
          </label>
          <fieldset className="flex gap-4">
            <legend className="text-text-secondary">Role</legend>
            {(["worker", "lead"] as const).map((r) => (
              <label key={r} className="flex items-center gap-1">
                <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
                {r === "worker" ? "Worker: does the work" : "Lead: splits, reviews, delegates"}
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-2">
          <p className="text-text-secondary">Which pages can it touch? Access covers sub-pages up to three levels.</p>
          {roots.length === 0 && <p className="text-text-tertiary">No pages yet. You can grant access later from the agent detail.</p>}
          <ul className="max-h-64 space-y-1 overflow-auto">
            {roots.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-bg-secondary">
                <span className="min-w-0 flex-1 truncate">{p.icon ? `${p.icon} ` : ""}{p.title || "Untitled"}</span>
                {SCOPES.map((s) => (
                  <label key={s} className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={grants[p.id]?.scopes.includes(s) ?? false} onChange={() => toggleScope(p.id, s)} />
                    {s}
                  </label>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {step === 2 && <ConnectionSnippet harness={harness} onChange={setHarness} />}

      {step === 3 && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-text-secondary">Monthly budget (USD, empty = no cap)</span>
            <input className="mt-1 w-40 rounded border border-border bg-bg px-2 py-1" value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
          </label>
          <label className="block">
            <span className="text-text-secondary">Calls per minute</span>
            <input className="mt-1 w-40 rounded border border-border bg-bg px-2 py-1" type="number" min={1} value={rate} onChange={(e) => setRate(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <fieldset>
            <legend className="text-text-secondary">What this connection can do</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {CAPABILITIES.map((c) => (
                <label key={c} className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={capabilities[c] ?? false} onChange={(e) => setCapabilities({ ...capabilities, [c]: e.target.checked })} />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      <div className="flex justify-between pt-2">
        <button type="button" className="rounded px-2 py-1 text-text-secondary hover:bg-bg-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <div className="flex gap-2">
          {step > 0 && (
            <button type="button" className="rounded border border-border px-2 py-1 hover:bg-bg-secondary" onClick={() => setStep(step - 1)} disabled={busy}>Back</button>
          )}
          {step < STEPS.length - 1 ? (
            <button type="button" className="rounded bg-accent px-3 py-1 text-white disabled:opacity-50" onClick={() => setStep(step + 1)} disabled={!canNext}>Next</button>
          ) : (
            <button type="button" className="rounded bg-accent px-3 py-1 text-white disabled:opacity-50" onClick={submit} disabled={busy || !canNext}>
              {busy ? "Creating…" : "Create agent"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
