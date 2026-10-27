# Reference agent

A small worker process that takes tasks delegated to it in the workspace, does them with any OpenAI-compatible model, and hands the result to a person for review. Plain Node 22, no dependencies.

## How it works

1. Waits for work with `wait_for_my_tasks` (the server holds each call up to 120 s and answers as soon as a task is queued or gets feedback).
2. Claims the task with `claim_task` and gives the model the brief, the previous deliverables and the recent activity.
3. Runs model turns. Each tool call the model makes goes to the workspace MCP server (`read_page`, `append_blocks`, `edit_page`, `post_activity`, `add_artifact`, `request_input`, `request_approval`, `submit_for_review`, ...).
4. Sends `heartbeat` after every model turn and at least every 5 minutes, with the tokens used and their measured cost.
5. After `request_approval` or `request_input` it pauses with `wait_for_task` until a person decides in the app.
6. Stops when the model calls `submit_for_review`. If the model stops without delivering, it calls `end_run` and the task goes back to the queue. A stop request from a person is acknowledged with `ack_stop`.

The agent never marks a task done; a person does.

## Run

```bash
cp agent/.env.example agent/.env   # fill in the values
node agent/index.mjs --env agent/.env
```

Ctrl+C stops after the current step; press it twice to quit at once.

## Settings

| Variable | Required | Meaning |
|---|---|---|
| `MODEL_BASE_URL` | yes | OpenAI-compatible base URL; the agent calls `POST {MODEL_BASE_URL}/chat/completions` with `tools` |
| `MODEL_API_KEY` | no | Bearer key for that endpoint (empty for local servers) |
| `MODEL_NAME` | yes | Model id sent with every request |
| `MODEL_PRICE_IN`, `MODEL_PRICE_OUT` | no | USD per million input and output tokens; default 0 |
| `WORKSPACE_MCP_URL` | yes | Remote MCP endpoint of the workspace |
| `WORKSPACE_AGENT_PAT` | yes | Personal access token of this agent, from Settings > Agents |
| `WORKSPACE_AGENT_TOKEN_URL` | no | PAT exchange endpoint; default `<MCP origin>/functions/v1/agent-token` |
| `AGENT_HARNESS_NAME` | no | Name shown on each run; default `reference-agent` |
| `AGENT_MAX_TURNS` | no | Model turns per run before giving up; default 40 |
| `NEXT_PUBLIC_APP_URL` | no | App URL for deep links in notifications |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | no | Send notifications to a Telegram chat instead of the console |

Example values for `MODEL_BASE_URL`: a hosted OpenAI-compatible API (`https://api.<provider>.com/v1`), an inference platform that serves open-weight models behind a chat completions endpoint, or a local server such as `http://localhost:11434/v1`. Pick a model that supports tool calling.

## Two instances

Each instance is one agent with its own token and model. Register two agents in Settings > Agents, then give each its own file:

```bash
node agent/index.mjs --env agent/.env.lead
node agent/index.mjs --env agent/.env.worker
```

The files only differ in `WORKSPACE_AGENT_PAT`, `AGENT_HARNESS_NAME` and, if you want, the model settings. Files named `.env*` are ignored by git.

## Notifications

Without `TELEGRAM_BOT_TOKEN` events are printed to the console. With it, the bot messages the owner chat when a task is claimed, when a decision is waiting (with a link to the task in the app) and when work is delivered. Decisions are always taken in the app. `/status` in the owner chat answers with what the agent is doing.

## Other harnesses

Any harness that speaks MCP connects to the same server and follows the same task flow; see `connect/`.

## Tests

`npx vitest run tests/agents/agentLoop.test.ts` runs the loop against `agent/test/stub-model.mjs` (a local scripted chat completions server) and `agent/test/stub-mcp.mjs` (an in-memory workspace). No network calls.
