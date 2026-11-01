# Connect Google Antigravity

Checked 2026-11-01

Connect Google Antigravity to shared pages and tasks. You need an installed client with custom remote MCP support and a colabora.si account allowed to connect agents. Review current configuration; preserve unrelated entries and approval rules. Follow the [setup boundaries](/connect.md#before-setup), with no extra packages or credentials in chat.

## Manual setup

For Antigravity CLI, merge these entries into `~/.gemini/config/mcp_config.json` or the workspace `.agents/mcp_config.json`. In the IDE, open its MCP configuration editor and merge the same entries:

```json
{
  "mcpServers": {
    "colabora-tasks": { "serverUrl": "https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp" },
    "colabora-workspace": { "serverUrl": "https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp" }
  }
}
```

Open `/mcp` in the CLI and reload. Remote OAuth is discovered automatically; approve access in your browser. The app's MCP Store may not offer custom configuration. If it does not, stop and use the CLI or IDE path instead.

## Verify and recover

Ask Google Antigravity to read the Getting started page and confirm its name. If approval expires, start sign-in again. Reload configuration if tools are missing. Stop at permission restrictions; do not disable safeguards or replace `serverUrl` with Gemini CLI's `httpUrl`.

[Antigravity MCP reference](https://antigravity.google/docs/mcp)
