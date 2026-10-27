"use client";

import { useState } from "react";
import { HARNESS_SNIPPETS, snippetFor } from "@/lib/agentSnippets";
import { mcpUrls } from "@/lib/agentsStore";

// Harness picker + copyable connection snippet.
export function ConnectionSnippet({ harness, onChange }: { harness: string; onChange?: (id: string) => void }) {
  const [copied, setCopied] = useState(false);
  const s = snippetFor(harness);
  const text = s.snippet(mcpUrls());
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <label className="text-text-secondary" htmlFor="agent-harness">Harness</label>
        <select
          id="agent-harness"
          className="rounded border border-border bg-bg px-2 py-1"
          value={s.id}
          onChange={(e) => onChange?.(e.target.value)}
          disabled={!onChange}
        >
          {HARNESS_SNIPPETS.map((h) => (
            <option key={h.id} value={h.id}>{h.name}</option>
          ))}
        </select>
        <span className="text-xs text-text-tertiary">{s.auth === "pat" ? "Personal access token" : "OAuth"}</span>
      </div>
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-bg-secondary p-2 font-mono text-xs whitespace-pre-wrap">{text}</pre>
      <div className="flex items-center gap-3">
        <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <span className="text-xs text-text-secondary">Wakes up: {s.wake}</span>
      </div>
      <ul className="list-disc pl-5 text-xs text-text-secondary">
        {s.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </div>
  );
}
