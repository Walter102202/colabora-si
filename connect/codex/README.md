# Codex

**Connection.** Remote MCP over HTTP. Add [`config.toml`](config.toml) to `~/.codex/config.toml` or `<repo>/.codex/config.toml`. Project files load only when the project's `.codex/` layer is trusted.

**Auth.** Agent token. Codex sends the JWT in `WORKSPACE_AGENT_JWT` as a bearer token. Get one with:

```bash
curl -s -X POST https://<project>.supabase.co/functions/v1/agent-token -H "Content-Type: application/json" -d '{"token":"agt_..."}'
```

The JWT lasts one hour. For longer sessions use the commented stdio block in `config.toml`: the bridge exchanges and renews the token itself.

**Limits.** `tool_timeout_sec` defaults to 60 s; the snippet sets 180 so `wait_for_task` (up to 120 s) fits. Codex shows no incoming MCP notifications.

## Waking a Codex Desktop session

Run `node connect/codex/watch.mjs` on the machine where Codex Desktop is open, with `WORKSPACE_MCP_URL` and `WORKSPACE_AGENT_PAT` set. The watcher waits outside Codex and carries corrections to the session recorded by the task's latest run for that agent. When claiming, pass `external_session_id` with the value of `CODEX_THREAD_ID`.

- `WORKSPACE_CODEX_THREAD`: explicit fallback for a task that has no session yet. Use the `CODEX_THREAD_ID` from that session; the watcher never guesses a session.
- `WORKSPACE_CODEX_BIN`: optional CLI path; on Windows it must point to the actual `.exe`, not a `.cmd` or `.bat` wrapper. The path is resolved again for each send, including after Desktop updates. Otherwise it uses the newest Desktop `codex.exe` under `%LOCALAPPDATA%/OpenAI/Codex/bin/`, then `codex` on PATH.
- `WORKSPACE_WATCH_STATE`: durable cursor, sent-notification and pending-notice file, default `~/.codex/colabora-watch.json`. Use a separate file for each agent/workspace watcher.

Use the watcher **or** the hook, never both: running both delivers the same correction twice. The hook remains the path for Codex CLI and for people who do not use Desktop. The watcher reaches only threads loaded in Desktop. Without `external_session_id` or an explicit fallback it has no destination; `approval_decided` does not wake a session. Busy-thread and closed-Desktop behavior require separate verification.

**Failure and restart behavior.** Retries use per-task exponential backoff (2, 4, 8, then 16 seconds). After five `get_task` or queue failures the task is quarantined in the state file and logged, so the scan cursor and other tasks can progress while the durable pending entry keeps ownership of delivery; only a successful queue write enters the sent ledger. Quarantined work retries automatically every five minutes. A new prompt, destination, brief or reason resets its entry immediately; a watcher restart also retries unsent work. Destinationless entries use the normal two-minute wait instead of thirty-second polling. Notices without a destination remain persisted; a later session notice or a configured fallback can deliver them. Restart restores the cursor and acknowledged prompt identities so already delivered notifications are not repeated.

The CLI child does not inherit `WORKSPACE_AGENT_PAT` or `WORKSPACE_AGENT_JWT`. State-save failures are logged and the process keeps in-memory progress, retrying persistence on later polls. There is no transaction between `codex queue` and the state file: a crash after a successful enqueue but before its acknowledgement is saved can still replay that notice. If persistence keeps failing, fix the state-file permissions/path before relying on restart deduplication.

**How it wakes up.** A Stop hook. Copy [`hooks.json`](hooks.json) to `<repo>/.codex/hooks.json` and set the path to `on-stop.mjs`. Hooks are on by default.

- When Codex ends its turn, [`on-stop.mjs`](on-stop.mjs) exchanges `WORKSPACE_AGENT_PAT` (with `WORKSPACE_MCP_URL`) and waits on `wait_for_my_tasks` for up to `HOOK_WAIT_MIN` minutes (25 by default, below the hook timeout of 1800 s).
- If a task of the agent gets feedback, is queued or its brief changes, the hook prints `{"decision":"block","reason":"…"}`. Codex continues with that reason as the next prompt, for example: `Task … has new feedback: …. Call claim_task("…"), resolve each finding and finish with submit_for_review.` The reason is at most 2,500 characters.
- The hook keeps waiting after a task closes or is stopped, so the session takes the next task that becomes ready; it ends without output after `HOOK_WAIT_MIN` minutes (25) with nothing to do.
- A task that waits on a person after a blocked or escalated review keeps the hook waiting; the person's answer continues the session.
- It never continues because of the clock. In a continuation it started (`stop_hook_active`), the first snapshot ignores old feedback and brief changes; queued tasks and handovers still count.

The hook runs with Codex's environment, so `WORKSPACE_MCP_URL` and `WORKSPACE_AGENT_PAT` must be set there. The hook never answers approvals: irreversible actions go through `request_approval` and the card in the app.

A task handed over to this agent wakes the session with reason `handover`, also while it waits on a person's decision; claim it with `resume: true`.
