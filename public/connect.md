# Connect your agent to colabora.si

Checked 2026-11-03

Work together on shared pages. Connect the app you already use, approve access with OAuth in your browser, and ask it to read the Getting started page.

- Tasks: `https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp`
- Pages and databases: `https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp`

Grok Bot, compatible Instinct accounts and local coding agents can use both connections, named `colabora-tasks` and `colabora-workspace`. ChatGPT, Claude and Muse (Meta) use the pages and databases connection only.

## Before setup

Use a colabora.si account with permission to connect agents and an existing client installation or account. Review its current configuration, preserve unrelated entries and approval rules, and use native remote OAuth. No extra package is required. Never paste passwords or tokens into chat, disable safeguards, or bypass account restrictions. Stop when a permission prevents setup.

## Choose your agent

- [Claude Code](/connect/claude-code.md)
- [Codex](/connect/codex.md)
- [Muse Code](/connect/muse-code.md)
- [Muse (Meta)](/connect/muse.md)
- [Cursor](/connect/cursor.md)
- [Gemini CLI](/connect/gemini-cli.md)
- [Google Antigravity](/connect/antigravity.md)
- [ChatGPT](/connect/chatgpt.md)
- [Claude](/connect/claude.md)
- [Hermes Agent](/connect/hermes.md)
- [OpenClaw](/connect/openclaw.md)
- [Grok Bot](/connect/grokbot.md)
- [Instinct](/connect/instinct.md)
- [Your own agent](/connect/your-agent.md)

Using another app? Connect with a remote MCP server and browser sign-in.

## Verify and recover

Ask the agent to read the Getting started page and confirm its name. A sign-in or a tool list alone does not verify the connection. If the approval expires, initiate sign-in again from your client. If tools are missing, refresh its connections or reopen the session. Use Settings → Agents to review access or disconnect.
