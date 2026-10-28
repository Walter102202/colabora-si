# bridge

A stdio MCP server for local harnesses (Claude Code). It does two things:

1. **Proxy.** Speaks MCP over stdio (newline-delimited JSON-RPC 2.0) and forwards every request to the remote MCP endpoint over HTTP. It exchanges the agent's personal access token (PAT) for a short-lived JWT at the `agent-token` function and sends it as `Authorization: Bearer`. On a `401` it exchanges once more and retries once. Request bodies (including `_meta.progressToken`) and the client's protocol version (`Mcp-Protocol-Version`) pass through unchanged; progress notifications streamed by the remote are written back to stdout as they arrive.
2. **Channel.** Declares the experimental `claude/channel` capability. When one of the agent's tasks changes, it writes a `notifications/claude/channel` event with a one-line `content` and `meta = {task_id, run_id, reason, state}`. An idle Claude Code session wakes up with it. Events come from Supabase Realtime (`postgres_changes` INSERT on `public.agent_events`, filtered to this agent, channel `agent-<agent_id>`). If Realtime is not configured or drops, the bridge loops on the remote tool `wait_for_my_tasks` with its cursor, so no change is lost.

`initialize`, `notifications/initialized` and `ping` are answered locally. stdout carries only protocol messages; logs go to stderr.

## Run

```bash
node bridge/index.mjs                  # proxy + channel
node bridge/index.mjs --no-channel     # proxy only
node bridge/index.mjs --channel-only   # channel + diagnostic tools, no proxy
```

Node 22 or later. Run it from a checkout of this repository (Realtime uses `@supabase/supabase-js` from the root `node_modules`).

| Variable | Meaning |
|---|---|
| `WORKSPACE_MCP_URL` | Remote MCP endpoint, e.g. `https://<project>.supabase.co/functions/v1/mcp` |
| `WORKSPACE_AGENT_PAT` | The agent's personal access token (`agt_…`), shown once when the agent is created |
| `WORKSPACE_AGENT_TOKEN_URL` | Token exchange endpoint. Default: `<origin of WORKSPACE_MCP_URL>/functions/v1/agent-token` |
| `WORKSPACE_SUPABASE_URL` | Supabase project URL of the workspace, for Realtime (usually the origin of `WORKSPACE_MCP_URL`) |
| `WORKSPACE_SUPABASE_KEY` | Public (publishable) key of that project, `sb_publishable_…`; Realtime needs it to open its socket. Without it the channel uses `wait_for_my_tasks` |
| `BRIDGE_LOG_FILE` | Optional. Appends every incoming and outgoing line, with a timestamp |
| `BRIDGE_DEMO_EVENT_AFTER_MS` | Optional, `--channel-only` only. Emits one demo channel event that many ms after start |

## Claude Code

`.mcp.json` in the project (see `connect/claude-code/`):

```json
{
  "mcpServers": {
    "colabora": {
      "command": "node",
      "args": ["bridge/index.mjs"],
      "env": {
        "WORKSPACE_MCP_URL": "https://<project>.supabase.co/functions/v1/mcp",
        "WORKSPACE_AGENT_PAT": "agt_…",
        "WORKSPACE_SUPABASE_URL": "https://<project>.supabase.co",
        "WORKSPACE_SUPABASE_KEY": "sb_publishable_…"
      }
    }
  }
}
```

Start an interactive session with the channel loaded:

```bash
MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:colabora
```

- The session confirms with "Channels (experimental) messages from server:colabora inject directly in this session".
- `MCP_PROTOCOL_NEGOTIATION=legacy` is required: a channel server that negotiates the newest protocol revision is not registered as a channel. `MCP_SDK_GENERATION=v1` is the alternative.
- With `-p` (non-interactive) the flag is ignored and no channel is registered; the session still has the tools.

## Local check without a workspace

`--channel-only` with an empty `WORKSPACE_MCP_URL` needs no remote and no Supabase. It exposes two diagnostic tools:

- `wait_demo {seconds}` sleeps and returns `{slept}`. Use it to see a long call move to the background.
- `emit_demo_event {content}` emits one channel event right away.

```bash
BRIDGE_DEMO_EVENT_AFTER_MS=60000 BRIDGE_LOG_FILE=/tmp/colabora-bridge.log \
  MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:colabora
```

with `"args": ["bridge/index.mjs", "--channel-only"]` and `"env": {"WORKSPACE_MCP_URL": ""}` in `.mcp.json`. The demo event is `demo: task RUN-1 ready_for_review`.
