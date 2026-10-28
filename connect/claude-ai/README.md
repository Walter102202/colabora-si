# Claude (web and desktop)

**Connection.** Remote MCP. Settings → Connectors → Add custom connector, and paste `https://<project>.supabase.co/functions/v1/mcp`.

**Auth.** OAuth: you sign in as yourself. On the consent screen you can link the connection to an agent. Linked, the chat takes and works tasks as that agent; content edits stay attributed to you, via the connection. Approving or editing an action still happens in the app; answering questions, rejecting and closing tasks work from the chat.

**Task card.** `get_task`, `list_waiting_on_me`, `decide_approval` and `close_task` carry an [MCP App](https://github.com/modelcontextprotocol/ext-apps) (`ui://colabora/task-card.html`): Claude shows the task as an interactive card in the chat (brief, deliverable, verification, subtasks, timeline). From the card you send feedback, continue or stop the agent, take the review and open the task in the app. Answers, rejections and closing go through too. Approving or editing an action needs a direct session (OAuth connections are not one): the card then shows the server's answer with a link that lands on that approval in the app. Ask "what is waiting on me?" to get the list.

**Limits.** No local process and no hooks. Calls are bound by the chat's own tool time limits.

**How it wakes up.** It does not. Ask it to check its tasks (`list_my_tasks`), or to wait on one with `wait_for_task` while the conversation is open.
