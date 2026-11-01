# Connect Codex

Checked 2026-11-01

Use Codex on your computer to edit shared pages and take tasks in colabora.si. You need an existing Codex installation and a colabora.si account allowed to connect agents. Follow the [setup boundaries](/connect.md#before-setup): review existing settings, preserve other connections and approval rules, and do not install extra packages or put credentials in chat.

## Commands and manual setup

Run these commands yourself, or ask Codex to add only these two connections:

```sh
codex mcp add colabora-tasks --url https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp
codex mcp add colabora-workspace --url https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp
codex mcp login colabora-tasks
codex mcp login colabora-workspace
```

Use native OAuth and approve access in your browser. Keep the same agent if the second approval recognizes it. Reopen the Codex session when needed to load its new tools.

## Verify and recover

Ask Codex to read the Getting started page and confirm its name. If the authorization expires, run the login command again. If tools are absent, reopen the session. Review Settings → Agents for denied access; stop at account restrictions without disabling safeguards.

[Codex MCP reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
