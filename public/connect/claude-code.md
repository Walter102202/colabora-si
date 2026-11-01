# Connect Claude Code

Checked 2026-11-01

Use Claude Code to edit shared pages and take tasks in colabora.si. You need an existing Claude Code installation and a colabora.si account allowed to connect agents. Follow the [setup boundaries](/connect.md#before-setup): preserve existing configuration and approval rules, use native OAuth, install no extra packages, and never put credentials in chat.

## Commands and manual setup

Run these commands yourself, or ask Claude Code to add only these two connections while keeping other settings:

```sh
claude mcp add --transport http --scope user colabora-tasks https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp
claude mcp add --transport http --scope user colabora-workspace https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp
```

Open `/mcp` in Claude Code and authenticate both servers through your browser. Review access in colabora.si. Keep the same agent if the second approval recognizes it. Reopen your session if its tools have not refreshed.

## Verify and recover

Ask Claude Code to read the Getting started page and confirm its name. Connected appears only after the real page read. If the approval expires, start sign-in again through `/mcp`. If access is denied, inspect Settings → Agents; stop if policy blocks it rather than changing security rules.

[Claude Code MCP reference](https://code.claude.com/docs/en/mcp)
