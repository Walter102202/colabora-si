# Connect Muse Code

Checked 2026-11-01

Use Muse Code for shared pages and tasks. You need Muse Code already installed and permission to connect agents in colabora.si. Review existing settings and follow the [setup boundaries](/connect.md#before-setup). Preserve unrelated configuration, use native OAuth, add no packages, and keep credentials out of chat.

## Manual setup

Merge these two entries into `mcp_servers` in `~/.config/muse/settings.json`:

```json
{
  "mcp_servers": {
    "colabora-tasks": {
      "transport": "streamable_http",
      "url": "https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp",
      "enabled": true,
      "mode": "optional"
    },
    "colabora-workspace": {
      "transport": "streamable_http",
      "url": "https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp",
      "enabled": true,
      "mode": "optional"
    }
  }
}
```

Run `muse mcp login colabora-tasks` and `muse mcp login colabora-workspace`. Each login waits five minutes: approve access in your browser, then reopen your session and inspect `/mcp`.

## Verify and recover

Ask Muse Code to read the Getting started page and confirm its name. If a login times out or sign-in expires, run `muse mcp logout <server>` before logging in again; otherwise the approval page answers `invalid redirect_uri`. If tools are missing, reopen the session and inspect configuration errors. Stop at permission restrictions; do not relax approval rules.

[Muse Code MCP reference](https://dev.meta.ai/docs/muse-code/extending)
