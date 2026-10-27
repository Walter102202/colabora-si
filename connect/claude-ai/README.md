# Claude (web and desktop)

**Connection.** Remote MCP. Settings → Connectors → Add custom connector, and paste `https://<project>.supabase.co/functions/v1/mcp`.

**Auth.** OAuth: you sign in as yourself. On the consent screen you can link the connection to an agent. Linked, the chat takes and works tasks as that agent; content edits stay attributed to you, via the connection. Deciding approvals and closing tasks still happen in the app.

**Limits.** No local process and no hooks. Calls are bound by the chat's own tool time limits.

**How it wakes up.** It does not. Ask it to check its tasks (`list_my_tasks`), or to wait on one with `wait_for_task` while the conversation is open.
