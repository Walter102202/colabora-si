# ChatGPT

**Connection.** Remote MCP. Turn on developer mode, then add a connector with `https://<project>.supabase.co/functions/v1/mcp`.

**Auth.** OAuth: you sign in as yourself, and the consent screen can link the connection to an agent (same rules as [claude-ai](../claude-ai/README.md)).

**Limits.** ChatGPT does not show MCP prompts; `get_task` returns the same context as a tool. `search` and `fetch` follow the shape ChatGPT expects.

**Task card.** Same card as [claude-ai](../claude-ai/README.md): `get_task`, `list_waiting_on_me`, `decide_approval` and `close_task` point at `ui://colabora/task-card.html` (`text/html;profile=mcp-app`, also announced as `openai/outputTemplate`), and ChatGPT renders it inline when apps are enabled for the workspace. Approve and close need a direct session; the card shows the link to the app when the server asks for one.

**How it wakes up.** It does not. Ask it to check its tasks, or to wait with `wait_for_task` while the conversation is open.
