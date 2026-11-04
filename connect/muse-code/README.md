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

**Limits.** Tested with OAuth on both endpoints on 2026-11-01 (Muse Code 1.4.14, Windows). `muse mcp login` waits five minutes for the approval. Muse reuses its registered client, but each login uses a new callback URL, so a repeated login fails with `invalid redirect_uri` until `muse mcp logout <server>` clears the registration.

## How it wakes up

Copy [`hooks.json`](hooks.json) to `<workspace root>/.muse/hooks.json` and replace both path placeholders. If that file already exists, merge the Stop entry and preserve unrelated hooks. Quote paths containing spaces inside the JSON command, for example:

```json
"command": "node \"<path-to-colabora>/connect/muse-code/on-stop.mjs\" --env \"<path-to-credentials-file>\""
```

Create the credentials file **outside the repository**, normally at `~/.config/muse/colabora.env`:

```text
WORKSPACE_MCP_URL=https://<project>.supabase.co/functions/v1/mcp
WORKSPACE_AGENT_PAT=agt_...
# Optional keys: HOOK_WAIT_MIN, WORKSPACE_AGENT_TOKEN_URL, WORKSPACE_HOOK_STATE
HOOK_WAIT_MIN=25
```

Muse starts hooks with a clean environment, so the token cannot come from the shell. The file is never printed, committed or pasted into chat. `--env <path>` (or `--env=<path>`) selects another file; omit the argument to use the default. If a future Muse version passes supported process variables, those override the file.

Start Muse from the workspace root containing `.muse/hooks.json`:

```sh
muse --trust-workspace -c max_consecutive_stop_hook_continuations=30
```

Hooks load only at session start and only with `--trust-workspace`. Muse stops continuing after 8 consecutive hook continuations by default; the recommended 30 covers a working day. Measured on Muse Code 1.4.14 (Windows, 2026-11-03).

- The hook waits outside the model for up to `HOOK_WAIT_MIN` (25 minutes by default). Keep this below the hook's 1800-second timeout.
- Feedback, queued work, a brief change or a handover continues the session with `{"decision":"block","reason":"…"}` and the shared task instructions. Lead notices use the same delivery and acknowledgement handling as Codex.
- It keeps waiting after a task closes. It never continues because of the clock; no new work means exit 0 without output.
- In a continuation (`stop_hook_active`), it ignores old feedback and brief changes while preserving queued work and handovers.
- Session state lives in `~/.config/muse/colabora-hook-<session_id>.json` (the id is sanitized and limited to 80 characters), or `WORKSPACE_HOOK_STATE`. Without a session id or override, state remains in memory. A plain queued task does not create a state file.
- The hook never answers approvals.

`muse session-message` does not work on Windows; use this Stop hook to continue the session.
