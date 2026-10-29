"use client";

import { useEffect, useRef, useState } from "react";
import { HARNESS_SNIPPETS, snippetFor } from "@/lib/agentSnippets";
import type { AgentKind, NewAgentInput } from "@/lib/agentsStore";
import { ConnectionSnippet } from "@/components/agents/settings/ConnectionSnippet";

const STEPS = ["Harness", "Paste", "Done"] as const;
const DEFAULT_CAPABILITIES: Record<string, boolean> = { start: false, continue: false, cancel: false, events: false, approval: true, cost: false, files: false };
const RESUME_HARNESSES = new Set(["claude-code", "codex", "cursor", "gemini-cli", "agent"]);

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
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<string>(HARNESS_SNIPPETS[0].id);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step === 0) nameRef.current?.focus();
  }, [step]);

  const snippet = snippetFor(harness);
  const canNext = step !== 0 || name.trim().length > 0;

  const submit = () => {
    onCreate({
      name: name.trim(),
      kind: HARNESS_KIND[harness] ?? "acp_local",
      role: "worker",
      capabilities: { ...DEFAULT_CAPABILITIES, resume: RESUME_HARNESSES.has(harness) },
      monthly_budget_usd: null,
      rate_limit_per_min: 120,
      grants: [],
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
          <div className="space-y-1">
            <label className="block text-text-secondary" htmlFor="new-agent-harness">Harness</label>
            <select id="new-agent-harness" className="w-full rounded border border-border bg-bg px-2 py-1" value={harness} onChange={(e) => setHarness(e.target.value)}>
              {HARNESS_SNIPPETS.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <ConnectionSnippet harness={harness} />
          <p className="text-text-secondary">Paste this where the recipe says, then come back and press Next.</p>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-2">
          <p>{name} on {snippet.name}.</p>
          <p className="text-text-secondary">Access to pages, budget and limits are set afterwards in the agent detail.</p>
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
