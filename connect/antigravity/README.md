# Antigravity

**Connection.** Local stdio server through the bridge. Add it in the MCP server settings (raw config), using the same `mcpServers` entry as [cursor/mcp.json](../cursor/mcp.json): `node <path-to-colabora>/bridge/index.mjs --no-channel` with `WORKSPACE_MCP_URL` and `WORKSPACE_AGENT_PAT`.

**Auth.** Agent token; the bridge exchanges and renews the JWT.

**Limits.** Documented, not tested. Check the current MCP documentation of the harness for where the raw config lives.

**How it wakes up.** It does not. The agent waits with `wait_for_task` or `wait_for_my_tasks`.
