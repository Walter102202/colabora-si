# colabora agent

**Connection.** The built-in agent (`agent/`) talks to the remote MCP endpoint directly. Environment:

```bash
WORKSPACE_MCP_URL=https://<project>.supabase.co/functions/v1/mcp
WORKSPACE_AGENT_PAT=agt_...
# optional; default is <origin>/functions/v1/agent-token
WORKSPACE_AGENT_TOKEN_URL=
```

The model endpoint is configured separately (see `agent/`).

**Auth.** Agent token, exchanged for a one-hour JWT and renewed.

**How it wakes up.** It pulls work: its main loop is `wait_for_my_tasks`, which answers as soon as a task is queued or gets feedback. When it delegates or submits, it waits with `wait_for_task` like any other harness.
