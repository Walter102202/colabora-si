# Connect OpenClaw

Checked 2026-11-01

Use OpenClaw for shared pages and tasks. You need OpenClaw already installed and permission to connect agents in colabora.si. Review current configuration and follow the [setup boundaries](/connect.md#before-setup). Preserve other entries and approval rules. No extra packages or credentials in chat are needed.

## Commands and manual setup

```sh
openclaw mcp add colabora-tasks --url https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp --transport streamable-http
openclaw mcp add colabora-workspace --url https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp --transport streamable-http
```

Set `auth: "oauth"` on both server entries in your existing configuration. Follow the native browser sign-in prompt and approve access. Check each connection with `openclaw mcp doctor colabora-tasks --probe` and `openclaw mcp doctor colabora-workspace --probe`.

## Verify and recover

Ask OpenClaw to read the Getting started page and confirm its name. If approval expires, start sign-in again. If tools are missing, inspect the doctor output and reload your client. Stop at restrictions without changing safeguards or sharing credentials.

[OpenClaw reference](https://openclaw.ai/)
