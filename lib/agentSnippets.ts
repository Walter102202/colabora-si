// Connection snippets per harness, shown in Settings → Agents → Connection.
// The human-readable recipes live in connect/<harness>/README.md; this table
// is what the UI renders and copies.

export type HarnessAuth = "pat" | "oauth";

export interface HarnessSnippet {
  id: string;
  name: string;
  auth: HarnessAuth;
  wake: string;
  snippet: (p: { mcpUrl: string; tokenUrl: string }) => string;
  notes: string[];
}

/** Origin of an URL, for the Supabase URL the bridge needs next to the MCP endpoint. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "https://<project>.supabase.co";
  }
}

const tokenNote = "Exchange the personal access token for a 1-hour JWT at the token URL; the bridge and the reference agent do it for you.";

/** The workspace connection shares credentials, but exposes pages and databases only. */
export function workspaceMcpUrl(mcpUrl: string): string {
  return mcpUrl.replace(/\/mcp\/?$/, "/workspace-mcp");
}

export const HARNESS_SNIPPETS: HarnessSnippet[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    auth: "pat",
    wake: "Channel: the bridge pushes task changes into the open session.",
    snippet: ({ mcpUrl, tokenUrl }) => `# .mcp.json in the project Claude Code runs in
{
  "mcpServers": {
    "colabora": {
      "command": "node",
      "args": ["bridge/index.mjs"],
      "env": {
        "WORKSPACE_MCP_URL": "${mcpUrl}",
        "WORKSPACE_AGENT_TOKEN_URL": "${tokenUrl}",
        "WORKSPACE_AGENT_PAT": "agt_...",
        "WORKSPACE_SUPABASE_URL": "${originOf(mcpUrl)}",
        "WORKSPACE_SUPABASE_KEY": "sb_publishable_..."
      }
    }
  }
}
MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:colabora`,
    notes: [tokenNote, "The two WORKSPACE_SUPABASE_* values are the workspace's public Supabase URL and publishable key (the channel listens on Realtime).", "Start the session with the channel registered.", "Without the channel flag the session still works: it waits with wait_for_task."],
  },
  {
    id: "codex",
    name: "Codex",
    auth: "pat",
    wake: "Stop hook: Codex continues its turn when feedback arrives.",
    snippet: ({ mcpUrl }) => `# ~/.codex/config.toml (or <repo>/.codex/config.toml)
[mcp_servers.colabora]
url = "${mcpUrl}"
bearer_token_env_var = "WORKSPACE_AGENT_JWT"
tool_timeout_sec = 180`,
    notes: [tokenNote, "Get a JWT with: curl -s -X POST https://<project>.supabase.co/functions/v1/agent-token -H \"Content-Type: application/json\" -d '{\"token\":\"agt_...\"}'. Set WORKSPACE_AGENT_JWT to the returned access_token.", "Copy connect/codex/hooks.json to <repo>/.codex/hooks.json and set the path to on-stop.mjs. Export WORKSPACE_MCP_URL and WORKSPACE_AGENT_PAT before starting Codex.", "The Stop hook (connect/codex/on-stop.mjs) waits up to 25 minutes for feedback and resumes the turn."],
  },
  {
    id: "claude-ai",
    name: "Claude (claude.ai, desktop)",
    auth: "oauth",
    wake: "Queued: the agent sees new work in its next conversation.",
    snippet: ({ mcpUrl }) => `Settings → Connectors → Add custom connector
URL: ${mcpUrl}
Sign in with your workspace account and choose which registered agent this connection represents.`,
    notes: ["Acts as you, or as an agent you pick on the consent screen."],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    auth: "oauth",
    wake: "Queued: the agent sees new work in its next conversation.",
    snippet: ({ mcpUrl }) => `Settings → Connectors → Create → MCP server
URL: ${mcpUrl}
Authentication: OAuth`,
    notes: ["Writes require a plan that allows write connectors; otherwise the connection is read-only."],
  },
  {
    id: "cursor",
    name: "Cursor",
    auth: "pat",
    wake: "Queued: waits with wait_for_task inside the session.",
    snippet: ({ mcpUrl }) => `# .cursor/mcp.json (or ~/.cursor/mcp.json)
{
  "mcpServers": {
    "colabora": {
      "command": "node",
      "args": ["<path-to-colabora>/bridge/index.mjs", "--no-channel"],
      "env": {
        "WORKSPACE_MCP_URL": "${mcpUrl}",
        "WORKSPACE_AGENT_PAT": "agt_..."
      }
    }
  }
}`,
    notes: [tokenNote],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI / Antigravity",
    auth: "pat",
    wake: "Queued: waits with wait_for_task inside the session.",
    snippet: ({ mcpUrl }) => `# ~/.gemini/settings.json (or .gemini/settings.json in the project)
{
  "mcpServers": {
    "colabora": {
      "command": "node",
      "args": ["<path-to-colabora>/bridge/index.mjs", "--no-channel"],
      "env": {
        "WORKSPACE_MCP_URL": "${mcpUrl}",
        "WORKSPACE_AGENT_PAT": "agt_..."
      }
    }
  }
}`,
    notes: [tokenNote],
  },
  {
    id: "agent",
    name: "Reference agent (agent/)",
    auth: "pat",
    wake: "Pull: the agent waits with wait_for_my_tasks and picks up work in seconds.",
    snippet: ({ mcpUrl }) => `# agent/.env
WORKSPACE_MCP_URL=${mcpUrl}
WORKSPACE_AGENT_PAT=agt_...
MODEL_BASE_URL=https://<openai-compatible endpoint>/v1
MODEL_API_KEY=...
MODEL_NAME=...
node agent/index.mjs --env agent/.env`,
    notes: ["Any OpenAI-compatible chat endpoint works; change the three MODEL_* values to switch models.", "WORKSPACE_AGENT_TOKEN_URL is optional; it defaults to <MCP origin>/functions/v1/agent-token."],
  },
  {
    id: "claude-code-workspace", name: "Claude Code � pages and databases", auth: "pat",
    wake: "Direct workspace editing; no task channel needed.",
    snippet: ({ mcpUrl, tokenUrl }) => "# .mcp.json � direct workspace editing\n" + JSON.stringify({ mcpServers: { "colabora-workspace": {
      command: "node", args: ["bridge/index.mjs", "--no-channel"],
      env: { WORKSPACE_MCP_URL: workspaceMcpUrl(mcpUrl), WORKSPACE_AGENT_TOKEN_URL: tokenUrl, WORKSPACE_AGENT_PAT: "agt_..." },
    } } }, null, 2),
    notes: ["Use this connection to create pages and databases without tasks. Connect colabora (mcp) too when you also work on tasks.", tokenNote],
  },
];

export function snippetFor(id: string): HarnessSnippet {
  return HARNESS_SNIPPETS.find((s) => s.id === id) ?? HARNESS_SNIPPETS.find((s) => s.id === "claude-code")!;
}
