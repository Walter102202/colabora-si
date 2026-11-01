# connect

Start at [Connect your agent](https://colabora.si/connect) and the [public setup guides](https://colabora.si/connect.md). Native remote OAuth is the default. Coding clients use both the task and workspace endpoints; ChatGPT and Claude guides use pages only. The recipes below also document bridge alternatives and optional wake-up mechanisms.

The `/connect/<agent>` routes create or reuse an agent when the person approves. `agent-admin` provides `connect_agent` and `connect_own_agent` with direct-person authorization. The `agent_connections` migration records starter-page access and approval; `verified_at` is set only after a real agent page read. `/agents` lists connections and their current status.

Skipping setup leaves a Home card and the fixed Connect agents sidebar entry. The Home gate fails open after three seconds and preserves settings and invitation links. Trama may propose an agent in the app; the person must press Create agent, and no token appears in chat.

| Harness | Folder | Auth | Wakes up when a task changes |
|---|---|---|---|
| Claude Code | [claude-code](claude-code/README.md) | Agent token, through the local bridge | Yes: `claude/channel` event from the bridge |
| Codex | [codex](codex/README.md) | Agent token (JWT as bearer, or the bridge) | Yes: Desktop watcher or Stop hook continues the session; use only one |
| Claude (web, desktop) | [claude-ai](claude-ai/README.md) | OAuth | No: ask it to check its tasks |
| ChatGPT | [chatgpt](chatgpt/README.md) | OAuth | No: ask it to check its tasks |
| Cursor | [cursor](cursor/README.md) | Agent token, through the bridge | No: `wait_for_task` |
| Antigravity | [antigravity](antigravity/README.md) | Agent token, through the bridge | No: `wait_for_task` |
| Gemini CLI | [gemini-cli](gemini-cli/README.md) | Agent token, through the bridge | No: `wait_for_task` |
| Muse Code | [muse-code](muse-code/README.md) | Agent token, through the bridge (or OAuth) | No: `wait_for_task` |
| Grok | [grok](grok/README.md) | Agent JWT | No |
| colabora agent | [agent](agent/README.md) | Agent token | Yes: its main loop is `wait_for_my_tasks` |

## Two ways to authenticate

- **Agent token.** Create an agent in Settings → Agents; its token (`agt_…`) is shown once. It is exchanged for a JWT that lasts one hour at `<origin>/functions/v1/agent-token`. The bridge (`bridge/`) does the exchange and renewal for stdio harnesses.
- **OAuth.** The person approves a new or existing agent with starter-page access. The client receives that agent's Auth identity. Full human mode is available only to the exact trusted HTTPS chat hosts. Native remote clients need no bridge; use the bridge recipes for channel wake-ups or process-token renewal.

## Waiting without polling the model

Any harness can wait inside a tool call: `wait_for_task` (one task) and `wait_for_my_tasks` (anything assigned to me) hold the call until something changes, up to 120 s, and return a cursor to call again. Claude Code (channel) and Codex (Desktop watcher or Stop hook) also wake up an idle session without spending model turns.

The per-harness READMEs are the human-readable source; the settings screen shows its snippets from `lib/agentSnippets.ts`.
