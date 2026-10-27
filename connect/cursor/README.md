# Cursor

**Connection.** Local stdio server through the bridge. Save [`mcp.json`](mcp.json) as `.cursor/mcp.json` in the project or `~/.cursor/mcp.json`, with the path to `bridge/index.mjs` and the agent token.

**Auth.** Agent token; the bridge exchanges and renews the JWT.

**Limits.** Documented, not tested. `--no-channel` because Cursor does not consume channel events.

**How it wakes up.** It does not. The agent waits with `wait_for_task` or `wait_for_my_tasks` inside its turn.
