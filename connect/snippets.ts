// Connection snippets per harness, shown by the agent settings screen.
// Each entry mirrors connect/<harness>/README.md. `<path-to-colabora>` is the
// folder of a local checkout of this repository; `agt_…` is the agent's
// personal access token, shown once when the agent is created.

export type HarnessSnippet = {
  name: string;
  title: string;
  auth: "pat" | "oauth";
  snippet: (p: { mcpUrl: string; tokenUrl: string }) => string;
  notes: string[];
};

const supabaseOrigin = (mcpUrl: string): string => {
  try { return new URL(mcpUrl).origin; } catch { return "https://<project>.supabase.co"; }
};

const bridgeServer = (p: { mcpUrl: string; tokenUrl: string }, extraArgs: string[] = []) => ({
  command: "node",
  args: ["<path-to-colabora>/bridge/index.mjs", ...extraArgs],
  env: {
    WORKSPACE_MCP_URL: p.mcpUrl,
    WORKSPACE_AGENT_TOKEN_URL: p.tokenUrl,
    WORKSPACE_AGENT_PAT: "agt_…",
    NEXT_PUBLIC_SUPABASE_URL: supabaseOrigin(p.mcpUrl),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_…",
  },
});

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export const HARNESS_SNIPPETS: Record<string, HarnessSnippet> = {
  "claude-code": {
    name: "claude-code",
    title: "Claude Code",
    auth: "pat",
    snippet: (p) => json({ mcpServers: { colabora: bridgeServer(p) } }),
    notes: [
      "Save as .mcp.json in the project. The bridge runs locally and exchanges the token for you.",
      "Start with: MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:colabora",
      "Task changes then wake the session through the colabora channel; no polling inside the model.",
    ],
  },
  codex: {
    name: "codex",
    title: "Codex",
    auth: "pat",
    snippet: (p) => [
      "[mcp_servers.colabora]",
      `url = "${p.mcpUrl}"`,
      'bearer_token_env_var = "WORKSPACE_AGENT_JWT"',
      "tool_timeout_sec = 180",
    ].join("\n"),
    notes: [
      "Add to ~/.codex/config.toml or <repo>/.codex/config.toml.",
      "WORKSPACE_AGENT_JWT comes from posting the agent token to the token URL; it lasts one hour. For longer sessions run the bridge as a stdio server instead (see connect/codex/README.md).",
      "Copy connect/codex/hooks.json to <repo>/.codex/hooks.json so a Stop hook continues the session when the Lead sends feedback.",
    ],
  },
  "claude-ai": {
    name: "claude-ai",
    title: "Claude (web and desktop)",
    auth: "oauth",
    snippet: (p) => p.mcpUrl,
    notes: [
      "Settings → Connectors → Add custom connector, paste the URL and sign in.",
      "The connection acts for you; link it to an agent on the consent screen to take tasks as that agent.",
      "Chats do not wake up by themselves: ask the chat to check its tasks (list_my_tasks, wait_for_task).",
    ],
  },
  chatgpt: {
    name: "chatgpt",
    title: "ChatGPT",
    auth: "oauth",
    snippet: (p) => p.mcpUrl,
    notes: [
      "Enable developer mode, then add a connector with this URL and sign in.",
      "ChatGPT does not show MCP prompts; get_task gives the same context as a tool.",
      "Chats do not wake up by themselves: ask the chat to check its tasks.",
    ],
  },
  cursor: {
    name: "cursor",
    title: "Cursor",
    auth: "pat",
    snippet: (p) => json({ mcpServers: { colabora: bridgeServer(p, ["--no-channel"]) } }),
    notes: [
      "Save as .cursor/mcp.json in the project or ~/.cursor/mcp.json.",
      "Cursor has no channel; to wait for a task, the agent calls wait_for_task.",
    ],
  },
  antigravity: {
    name: "antigravity",
    title: "Antigravity",
    auth: "pat",
    snippet: (p) => json({ mcpServers: { colabora: bridgeServer(p, ["--no-channel"]) } }),
    notes: [
      "Add through the MCP server settings (raw config). Not tested.",
      "No wake-up mechanism; the agent waits with wait_for_task.",
    ],
  },
  "gemini-cli": {
    name: "gemini-cli",
    title: "Gemini CLI",
    auth: "pat",
    snippet: (p) => json({ mcpServers: { colabora: bridgeServer(p, ["--no-channel"]) } }),
    notes: [
      "Merge into ~/.gemini/settings.json or .gemini/settings.json. Not tested.",
      "No wake-up mechanism; the agent waits with wait_for_task.",
    ],
  },
  "muse-code": {
    name: "muse-code",
    title: "Muse Code",
    auth: "pat",
    snippet: (p) => json({ mcp_servers: { colabora: { transport: "stdio", ...bridgeServer(p, ["--no-channel"]), mode: "optional" } } }),
    notes: [
      "Merge into ~/.config/muse/settings.json and restart Muse Code; /mcp lists the tools. Not tested.",
      "Muse Code also accepts remote servers (transport streamable_http with url and headers, or OAuth via muse mcp login).",
      "No wake-up mechanism; the agent waits with wait_for_task.",
    ],
  },
  grok: {
    name: "grok",
    title: "Grok",
    auth: "pat",
    snippet: (p) => json({ type: "mcp", server_label: "colabora", server_url: p.mcpUrl, authorization: "<agent JWT>" }),
    notes: [
      "A remote MCP tool entry for an API request. Field names follow the provider's remote MCP documentation; verify before use. Not tested.",
      "The JWT comes from the token exchange and lasts one hour.",
    ],
  },
  agent: {
    name: "agent",
    title: "colabora agent",
    auth: "pat",
    snippet: (p) => [
      `WORKSPACE_MCP_URL=${p.mcpUrl}`,
      `WORKSPACE_AGENT_TOKEN_URL=${p.tokenUrl}`,
      "WORKSPACE_AGENT_PAT=agt_…",
    ].join("\n"),
    notes: [
      "Environment of the built-in agent (agent/). It waits for work with wait_for_my_tasks.",
      "The model endpoint is configured separately (see agent/).",
    ],
  },
};

