# Connect Cursor

Checked 2026-11-01

Connect Cursor to shared pages and tasks. You need Cursor already installed and permission to connect agents in colabora.si. Review current settings, preserve unrelated entries and approval rules, and follow the [setup boundaries](/connect.md#before-setup). No extra package or chat credential is needed.

## Manual setup

Open Customize → MCP to review servers. Merge these entries into the project `.cursor/mcp.json` or your account's `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "colabora-tasks": { "url": "https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp" },
    "colabora-workspace": { "url": "https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp" }
  }
}
```

Authenticate both remote servers with native OAuth. Review and approve in your browser. The selector's install link adds the workspace server; add the tasks server here too for task tools.

## Verify and recover

Ask Cursor to read the Getting started page and confirm its name. If the app did not open, open Cursor yourself and use these steps. For expired approval, initiate sign-in again. Refresh MCP settings if tools are missing. Stop at account restrictions without changing safeguards.

[Cursor MCP reference](https://cursor.com/docs/mcp) · [Install links](https://cursor.com/docs/mcp/install-links)
