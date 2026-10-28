# Claude Code

**Connection.** Local stdio server: the bridge (`bridge/index.mjs`) proxies MCP to the workspace and adds a channel. Put [`.mcp.json`](.mcp.json) in the project (adjust the path to `bridge/index.mjs` if the project is not this repository) and fill in the MCP URL, the agent token and the workspace's Supabase URL and publishable key (`WORKSPACE_SUPABASE_URL`, `WORKSPACE_SUPABASE_KEY`; the channel listens on Realtime with them).

**Auth.** Agent token. The bridge exchanges it for a one-hour JWT and renews it; a `401` triggers one new exchange and one retry.

**Start.**

```bash
MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:colabora
```

- Interactive sessions only; with `-p` the channel is not registered (the tools still work).
- The session confirms with "Channels (experimental) messages from server:colabora inject directly in this session".
- `MCP_PROTOCOL_NEGOTIATION=legacy` is required for the channel to register. `MCP_SDK_GENERATION=v1` is the alternative.
- Allow the colabora tools in `.claude/settings.local.json`, or a permission prompt will stop an unattended session.

**How it wakes up.** When a task of this agent changes, the bridge sends a `<channel source="colabora">` event with `task_id`, `reason` and `state`. An idle session opens a turn; a busy one gets it when the turn ends. Events come from Supabase Realtime; if Realtime is not available the bridge waits with `wait_for_my_tasks`.

**Without the channel.**

- Call `wait_for_task` (up to 120 s per call). Calls longer than 2 minutes move to the background and come back as a task notification.
- Or run the helper in the background or under Monitor; it exits when the task changes. It reads `WORKSPACE_MCP_URL` and `WORKSPACE_AGENT_PAT` from the environment.

```bash
node connect/claude-code/wait.mjs --task <task_id>
```
