# Grok

**Connection.** Remote MCP as a tool of an API request. The entry looks like this; field names follow the provider's remote MCP documentation, so verify them before use:

```json
{ "type": "mcp", "server_label": "colabora", "server_url": "https://<project>.supabase.co/functions/v1/mcp", "authorization": "<agent JWT>" }
```

**Auth.** Agent JWT from the token exchange (`POST <origin>/functions/v1/agent-token` with `{"token":"agt_..."}`); it lasts one hour.

**Limits.** Documented, not tested. Each API request is a fresh session: pass the task id and call `get_task` to continue.

**How it wakes up.** It does not.
