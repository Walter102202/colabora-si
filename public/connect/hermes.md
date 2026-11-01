# Connect Hermes Agent

Checked 2026-11-01

Use Hermes Agent for shared pages and tasks. You need Hermes Agent already installed and a colabora.si account allowed to connect agents. Review current configuration and follow the [setup boundaries](/connect.md#before-setup). Preserve other entries and approval rules; add no packages or credentials in chat.

## Manual setup

Merge only these two entries into `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  colabora-tasks:
    url: "https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp"
    auth: oauth
  colabora-workspace:
    url: "https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp"
    auth: oauth
```

In a separate terminal run `hermes mcp login colabora-tasks` and `hermes mcp login colabora-workspace`, approving access in your browser. Run `/reload-mcp` in your session.

## Verify and recover

Ask Hermes Agent to read the Getting started page and confirm its name. If approval expires, repeat the login. If tools are missing, reload MCP. Stop at account restrictions and inspect Settings → Agents rather than relaxing safeguards.

[Hermes Agent reference](https://github.com/NousResearch/hermes-agent)
