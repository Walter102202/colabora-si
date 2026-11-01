# Connect Gemini CLI

Checked 2026-11-01

Use Gemini CLI for shared pages and tasks. You need an existing installation and a colabora.si account allowed to connect agents. Review current configuration and follow the [setup boundaries](/connect.md#before-setup): preserve other entries and security rules, install no extra packages, and never put credentials in chat.

## Commands and manual setup

```sh
gemini mcp add --transport http colabora-tasks https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp
gemini mcp add --transport http colabora-workspace https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp
```

These commands use the current project scope. In your Gemini CLI session, use `/mcp auth` to sign in to both servers through native OAuth. Review access in the browser, then use `/mcp reload`.

## Verify and recover

Ask Gemini CLI to read the Getting started page and confirm its name. If approval expires, authenticate again. If tools are missing, reload MCP and inspect its connection status. Stop at permission restrictions without disabling safeguards.

[Gemini CLI MCP reference](https://geminicli.com/docs/tools/mcp-server/)
