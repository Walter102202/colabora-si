# Codex

**Connection.** Remote MCP over HTTP. Add [`config.toml`](config.toml) to `~/.codex/config.toml` or `<repo>/.codex/config.toml`. Project files load only when the project's `.codex/` layer is trusted.

**Auth.** Agent token. Codex sends the JWT in `WORKSPACE_AGENT_JWT` as a bearer token. Get one with:

```bash
curl -s -X POST https://<project>.supabase.co/functions/v1/agent-token -H "Content-Type: application/json" -d '{"token":"agt_..."}'
```

The JWT lasts one hour. For longer sessions use the commented stdio block in `config.toml`: the bridge exchanges and renews the token itself.

**Limits.** `tool_timeout_sec` defaults to 60 s; the snippet sets 180 so `wait_for_task` (up to 120 s) fits. Codex shows no incoming MCP notifications.

**How it wakes up.** A Stop hook. Copy [`hooks.json`](hooks.json) to `<repo>/.codex/hooks.json` and set the path to `on-stop.mjs`. Hooks are on by default.

- When Codex ends its turn, [`on-stop.mjs`](on-stop.mjs) exchanges `WORKSPACE_AGENT_PAT` (with `WORKSPACE_MCP_URL`) and waits on `wait_for_my_tasks` for up to `HOOK_WAIT_MIN` minutes (25 by default, below the hook timeout of 1800 s).
- If a task of the agent gets feedback, is queued or its brief changes, the hook prints `{"decision":"block","reason":"…"}`. Codex continues with that reason as the next prompt, for example: `Task … has feedback from the Lead: …. Call claim_task("…"), resolve each finding and finish with submit_for_review.` The reason is at most 2,500 characters.
- If the task is done, was escalated to a person, or nothing happened before the limit, the hook exits 0 with no output and Codex stops normally.
- It never continues because of the clock. In a continuation it started (`stop_hook_active`), only changes after that point count.

The hook runs with Codex's environment, so `WORKSPACE_MCP_URL` and `WORKSPACE_AGENT_PAT` must be set there. The hook never answers approvals: irreversible actions go through `request_approval` and the card in the app.

A task handed over to this agent wakes the session with reason `handover`; claim it with `resume: true`.
