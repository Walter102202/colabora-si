import { workspaceMcpUrl } from "@/lib/agentSnippets";

export const CONNECT_AGENT_NAMES: Record<string, string> = {"claude-code": "Claude Code", "codex": "Codex", "muse-code": "Muse Code", "cursor": "Cursor", "gemini-cli": "Gemini CLI", "antigravity": "Google Antigravity", "chatgpt": "ChatGPT", "claude": "Claude", "hermes": "Hermes Agent", "openclaw": "OpenClaw", "grokbot": "Grok Bot", "instinct": "Instinct", "your-agent": "Your own agent"};

const logoFormats: Record<string, string> = { grokbot: "jpg", instinct: "png" };

export function connectAgentLogo(id: string): string {
  return `/brand/agents/${id}.${logoFormats[id] ?? "svg"}`;
}

export interface ConnectCatalogEntry {
  id: string;
  name: string;
  route: "message" | "open" | "settings" | "own";
  action: string;
  helper: string;
  intro: string;
  cmd: string;
  outro: string;
  logo: string;
  guide: string;
  url?: string;
}

export function setupMessage(entry: ConnectCatalogEntry): string {
  return [entry.intro, entry.cmd, entry.outro].filter(Boolean).join("\n\n");
}

/** Pass mcpUrls().mcpUrl from the connected UI; keep configuration out of this catalog. */
export function createAgentConnectCatalog(mcpUrl: string): ConnectCatalogEntry[] {
  const endpoint = new URL(mcpUrl);
  if (!/^https?:$/.test(endpoint.protocol) || mcpUrl.includes("<project>")) throw new Error("Configure the workspace connection URL first.");
  const workspace = workspaceMcpUrl(mcpUrl);
  const read = "Then read the Getting started page and confirm its name.";
  const intro = (name: string) => `Connect ${name} to my colabora.si workspace. Add only these two connections and keep my existing settings and approval rules:`;
  const outro = "Use OAuth and let me approve access in my browser. Then use the connection to read the Getting started page and confirm its name. If this chat needs to reload, tell me the next step.";
  const guide = (name: string, slug: string, pagesOnly = false) => `Connect ${name} to my colabora.si workspace using the setup guide at https://colabora.si/connect/${slug}.md. Add only ${pagesOnly ? "this connection" : "these two connections"}, keep my existing settings and approval rules, and let me approve access in my browser. ${read} If you cannot add it here, show me the next step.`;
  const urls = `Tasks: ${mcpUrl}\nPages: ${workspace}`;
  const chatServers = `colabora-tasks: ${mcpUrl}\ncolabora-workspace: ${workspace}`;
  const chatApproval = "Use Streamable HTTP and OAuth. Show me the browser authorization for each server and wait for me to approve. I’ll select the same colabora.si agent for both. Then use colabora-workspace to read the Getting started page and tell me its title.";
  const choices: Omit<ConnectCatalogEntry, "logo" | "guide">[] = [
    { id: "claude-code", name: CONNECT_AGENT_NAMES["claude-code"], route: "message", action: "Copy setup message", helper: "Paste this into Claude Code. Then approve access in your browser.", intro: intro("Claude Code"), cmd: `claude mcp add --transport http --scope user colabora-tasks ${mcpUrl}\nclaude mcp add --transport http --scope user colabora-workspace ${workspace}`, outro },
    { id: "codex", name: CONNECT_AGENT_NAMES["codex"], route: "message", action: "Copy setup message", helper: "Paste this into Codex on your computer. Then approve access in your browser.", intro: intro("Codex"), cmd: `codex mcp add colabora-tasks --url ${mcpUrl}\ncodex mcp add colabora-workspace --url ${workspace}`, outro },
    { id: "muse-code", name: CONNECT_AGENT_NAMES["muse-code"], route: "message", action: "Copy setup message", helper: "Paste this into Muse Code. It may ask to update its settings or reopen the session.", intro: guide("Muse Code", "muse-code"), cmd: urls, outro: "" },
    { id: "cursor", name: CONNECT_AGENT_NAMES["cursor"], route: "open", action: "Open Cursor", helper: "Review the connection in Cursor. Then approve page access in your browser.", intro: guide("Cursor", "cursor"), cmd: urls, outro: "", url: `cursor://anysphere.cursor-deeplink/mcp/install?name=colabora-workspace&config=${encodeURIComponent(btoa(JSON.stringify({ url: workspace })))}` },
    { id: "gemini-cli", name: CONNECT_AGENT_NAMES["gemini-cli"], route: "message", action: "Copy setup message", helper: "Paste this into Gemini CLI. Then follow its sign-in prompt.", intro: guide("Gemini CLI", "gemini-cli"), cmd: urls, outro: "" },
    { id: "antigravity", name: CONNECT_AGENT_NAMES["antigravity"], route: "settings", action: "Show setup steps", helper: "Add colabora.si in Google Antigravity’s connection settings, then approve access in your browser.", intro: guide("Google Antigravity", "antigravity"), cmd: urls, outro: "", url: "https://antigravity.google/" },
    { id: "chatgpt", name: CONNECT_AGENT_NAMES["chatgpt"], route: "settings", action: "Open ChatGPT Plugins", helper: "Add colabora.si as a custom connection. Then sign in and review page access.", intro: guide("ChatGPT", "chatgpt", true), cmd: workspace, outro: "", url: "https://chatgpt.com/" },
    { id: "claude", name: CONNECT_AGENT_NAMES["claude"], route: "settings", action: "Open Claude Connectors", helper: "Add colabora.si as a custom connector. Then sign in and review page access.", intro: guide("Claude", "claude", true), cmd: workspace, outro: "", url: "https://claude.ai/" },
    { id: "hermes", name: CONNECT_AGENT_NAMES["hermes"], route: "message", action: "Copy setup message", helper: "Paste this into Hermes Agent. Then sign in and approve access in your browser.", intro: "Connect Hermes Agent to my colabora.si workspace. Add only these two connections to ~/.hermes/config.yaml and keep my existing settings and approval rules:", cmd: `mcp_servers:\n  colabora-tasks:\n    url: "${mcpUrl}"\n    auth: oauth\n  colabora-workspace:\n    url: "${workspace}"\n    auth: oauth`, outro: `Then tell me to run hermes mcp login colabora-tasks and hermes mcp login colabora-workspace in a separate terminal, so I can approve access in my browser. After that, run /reload-mcp. ${read}` },
    { id: "openclaw", name: CONNECT_AGENT_NAMES["openclaw"], route: "message", action: "Copy setup message", helper: "Paste this into OpenClaw. Then sign in and approve access in your browser.", intro: intro("OpenClaw"), cmd: `openclaw mcp add colabora-tasks --url ${mcpUrl} --transport streamable-http\nopenclaw mcp add colabora-workspace --url ${workspace} --transport streamable-http`, outro: `Set auth: "oauth" on both servers, then let me sign in and approve access in my browser. Check them with openclaw mcp doctor colabora-tasks --probe and openclaw mcp doctor colabora-workspace --probe. ${read}` },
    { id: "grokbot", name: CONNECT_AGENT_NAMES.grokbot, route: "message", action: "Copy setup message", helper: "Paste this into your Grok Bot chat. Open each connection card and review access in your browser.", intro: intro("Grok Bot"), cmd: chatServers, outro: chatApproval },
    { id: "instinct", name: CONNECT_AGENT_NAMES.instinct, route: "message", action: "Copy setup message", helper: "Send this to your Instinct. Setup requires an account that can add custom MCP servers with browser sign-in.", intro: intro("Instinct"), cmd: chatServers, outro: `${chatApproval} If your account cannot add a custom server or complete browser sign-in, stop and tell me. Do not ask me to paste tokens or callback links into chat.` },
    { id: "your-agent", name: CONNECT_AGENT_NAMES["your-agent"], route: "own", action: "Create agent token", helper: "For an agent you run yourself, on your computer or a server.", intro: guide("my agent", "your-agent"), cmd: urls, outro: "" },
  ];
  return choices.map((entry) => ({ ...entry, logo: connectAgentLogo(entry.id), guide: `/connect/${entry.id}.md` }));
}
