"use client";

import { useState } from "react";
import { mcpUrls } from "@/lib/agentsStore";
import { snippetFor } from "@/lib/agentSnippets";

// Minimal page that tells a person (or an agent that landed here) how to get
// an agent token and where the MCP endpoint is. Mounted by the `/mcp-pat`
// route, which belongs to the app shell; the content lives here.
export function McpPatPage({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { mcpUrl, tokenUrl } = mcpUrls();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };
  const claudeCode = snippetFor("claude-code");

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10 text-sm" aria-labelledby="mcp-pat-title">
      <header className="space-y-2">
        <h1 id="mcp-pat-title" className="text-2xl font-semibold">Connect an agent with a token</h1>
        <p className="text-text-secondary">
          Agents reach this workspace through one remote MCP endpoint. Harnesses that cannot sign in with OAuth use an agent token instead.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="font-medium">1. Create the agent and copy its token</h2>
        <p className="text-text-secondary">
          Open <strong>Settings → Agents</strong>, create an agent and choose the pages it may read and write. Its token (<code>agt_…</code>) is shown once; store it where the harness runs.
        </p>
        {onOpenSettings && (
          <button type="button" className="rounded bg-accent px-3 py-1.5 text-white" onClick={onOpenSettings}>
            Open Settings → Agents
          </button>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">2. Point the harness at the endpoint</h2>
        <dl className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <dt className="w-28 text-text-secondary">MCP endpoint</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2">
              <code className="truncate rounded bg-bg-secondary px-2 py-1">{mcpUrl}</code>
              <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" onClick={() => copy("mcp", mcpUrl)}>
                {copied === "mcp" ? "Copied" : "Copy"}
              </button>
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="w-28 text-text-secondary">Token exchange</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2">
              <code className="truncate rounded bg-bg-secondary px-2 py-1">{tokenUrl}</code>
              <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" onClick={() => copy("token", tokenUrl)}>
                {copied === "token" ? "Copied" : "Copy"}
              </button>
            </dd>
          </div>
        </dl>
        <p className="text-text-secondary">
          The token is exchanged for a one-hour access token at the exchange URL (<code>POST</code> with <code>{"{\"token\":\"agt_…\"}"}</code>). The local bridge in <code>bridge/</code> does this for stdio harnesses and renews it.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">3. Example: {claudeCode.name}</h2>
        <pre className="overflow-x-auto rounded bg-bg-secondary p-3 text-xs"><code>{claudeCode.snippet({ mcpUrl, tokenUrl })}</code></pre>
        <p className="text-text-secondary">Recipes for every harness are in <code>connect/</code>; the Agents settings tab shows the same snippets with your values filled in.</p>
      </section>

      <section className="space-y-1 text-text-secondary">
        <h2 className="font-medium text-text">Chat apps</h2>
        <p>Claude and ChatGPT connect with OAuth: add the MCP endpoint as a connector and sign in. Acts as you, or as an agent you pick on the consent screen.</p>
      </section>
    </main>
  );
}
