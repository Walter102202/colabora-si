# Muse Code

**MCP support.** Yes, per the official documentation (checked 2026-10-27):

- Servers are declared in the `mcp_servers` block of the settings file, `~/.config/muse/settings.json`.
- Transports: `stdio` (`command`, `args`, `env`) and `streamable_http` (`url`, `headers`).
- Each server also takes `enabled` and `mode`. `mode` defaults to `required`, which aborts the run if the server fails; `optional` skips it with a warning.
- Values support `${VAR}` interpolation.
- Remote servers can use OAuth 2.1: `muse mcp login <server>`. `/mcp` in a session lists connected servers and their tools.
- MCP servers run outside the Muse Code sandbox.

Sources: https://dev.meta.ai/docs/muse-code/extending and https://dev.meta.ai/docs/muse-code/configuration (2026-10-27).

**Connection.** Local stdio server through the bridge. Merge into `~/.config/muse/settings.json` and restart Muse Code:

```json
{
  "mcp_servers": {
    "colabora": {
      "transport": "stdio",
      "command": "node",
      "args": ["<path-to-colabora>/bridge/index.mjs", "--no-channel"],
      "env": {
        "WORKSPACE_MCP_URL": "https://<project>.supabase.co/functions/v1/mcp",
        "WORKSPACE_AGENT_PAT": "${WORKSPACE_AGENT_PAT}"
      },
      "mode": "optional"
    }
  }
}
```

Alternative without a local process: `"transport": "streamable_http"` with `"url"` set to the MCP endpoint, then `muse mcp login colabora` to sign in with OAuth.

**Auth.** Agent token through the bridge, which exchanges and renews the JWT. With `streamable_http`, OAuth as a person (the consent screen can link the connection to an agent).

**Limits.** Documented, not tested.

**How it wakes up.** It does not. The agent waits with `wait_for_task` or `wait_for_my_tasks`. Muse Code lists a `Stop` hook event (`<project-root>/.muse/hooks.json`), but its continuation behavior is not documented, so the Codex hook is not reused here.
