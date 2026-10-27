# Gemini CLI

**Connection.** Local stdio server through the bridge. Merge into `~/.gemini/settings.json` (or `.gemini/settings.json` in the project):

```json
{
  "mcpServers": {
    "colabora": {
      "command": "node",
      "args": ["<path-to-colabora>/bridge/index.mjs", "--no-channel"],
      "env": {
        "WORKSPACE_MCP_URL": "https://<project>.supabase.co/functions/v1/mcp",
        "WORKSPACE_AGENT_PAT": "agt_..."
      }
    }
  }
}
```

**Auth.** Agent token; the bridge exchanges and renews the JWT.

**Limits.** Documented, not tested.

**How it wakes up.** It does not. The agent waits with `wait_for_task` or `wait_for_my_tasks`.
