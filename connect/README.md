# connect

How each harness connects to a colabora workspace. Every harness reaches the same remote MCP endpoint (`https://<project>.supabase.co/functions/v1/mcp`); what changes is how it authenticates and how it learns that a task changed.

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
- **OAuth.** Chat apps sign in as a person. On the consent screen the connection can be linked to an agent, so the chat takes tasks as that agent and content edits are attributed to the agent, via the person who connected the chat.

## Waiting without polling the model

Any harness can wait inside a tool call: `wait_for_task` (one task) and `wait_for_my_tasks` (anything assigned to me) hold the call until something changes, up to 120 s, and return a cursor to call again. Claude Code (channel) and Codex (Desktop watcher or Stop hook) also wake up an idle session without spending model turns.

The per-harness READMEs are the human-readable source; the settings screen shows its snippets from `lib/agentSnippets.ts`.
