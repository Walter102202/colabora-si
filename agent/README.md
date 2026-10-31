# Reference agent

Lead notices are acknowledged only after a successful model response. Undelivered notices survive process interruption on the server. The CLI keeps delivered-but-unacknowledged notice ids beside its environment file as `<env-file>.notices.json`, so restarting retries acknowledgement without sending the same notice to the model again. Run one consumer per agent/configuration; local state-write failures are reported and retain progress in memory.

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

## Managed runtime

`fleet.mjs` runs one agent per workspace of a deployment, as the `trama` daemon of `vercel.json`. It reads `VITE_SUPABASE_URL`, `VITE_APP_URL`, `META_MODEL_API_KEY` and `TRAMA_RUNTIME_SECRET` from the project and refuses to start without them. This folder is the Docker build context, so nothing `fleet.mjs` loads may live outside it.

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
| `AGENT_REVIEWER_AGENT_ID` | no | Agent id of the reviewer instance a Lead delegates review tasks to; empty disables the review protocol |
| `WORKSPACE_APP_URL` | no | Public URL of the web app, for deep links in notifications |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | no | Send notifications to a Telegram chat instead of the console |
| `AGENT_DISPLAY_NAME` | no | Public identity in the task prompt, for example `Trama`; the harness remains the run identifier |
| `AGENT_INBOX` | no | `1` on the platform agent: what the owner writes or says on Telegram reaches the workspace |
| `AGENT_TIMEZONE` | no | IANA zone for the dates of notes, such as `America/Santiago` |
| `FFMPEG_PATH` | no | The `ffmpeg` binary, needed for Telegram voice notes (default `ffmpeg`) |

Example values for `MODEL_BASE_URL`: a hosted OpenAI-compatible API (`https://api.<provider>.com/v1`), an inference platform that serves open-weight models behind a chat completions endpoint, or a local server such as `http://localhost:11434/v1`. Pick a model that supports tool calling.

## Run as the workspace's Colabora agent

In Settings > Agents, press "Enable the Colabora agent" and copy the token shown once. Copy `agent/.env.example` to `agent/.env.colabora` and fill in these settings:

```text
MODEL_BASE_URL=<Meta Model API base URL ending in /v1>   # see the compatibility check below
MODEL_API_KEY=<Meta Model API key>
MODEL_NAME=muse-spark-1.3                                 # must equal the model_prices row
MODEL_PRICE_IN=1.25
MODEL_PRICE_OUT=4.25
WORKSPACE_MCP_URL=https://<project-ref>.supabase.co/functions/v1/mcp
WORKSPACE_AGENT_PAT=agt_...                               # the token shown once by "Enable the Colabora agent"
AGENT_HARNESS_NAME=colabora
AGENT_MAX_TURNS=40
WORKSPACE_APP_URL=https://<app>
```

Run the instance with `node agent/index.mjs --env agent/.env.colabora`. Files named `.env*` are ignored by git.

### Compatibility check

Before running Colabora against the Meta Model API, run this manual check with your actual base URL and key. It must return `get_weather` as `tool_calls[0].function.name`:

```bash
curl -s "$MODEL_BASE_URL/chat/completions" -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" -d '{
  "model": "muse-spark-1.3",
  "messages": [{"role":"user","content":"What is the weather in Madrid? Use the tool."}],
  "tools": [{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
  "tool_choice": "auto"}' | python -c "import json,sys; r=json.load(sys.stdin); print(r['choices'][0]['message']['tool_calls'][0]['function'], r['usage'])"
```

If the response lacks `choices[0].message.tool_calls` or `usage.prompt_tokens`, the API does not match `agent/model.mjs`. Put an OpenAI-compatible endpoint in front of it before using this instance.

## Reviewer instance on Baseten

Register "Colabora Reviewer" in Settings > Agents with New agent, harness "Reference agent" and role Worker, or use the local seed's reviewer. Each instance uses its own agent token.

Copy the reviewer's agent id from Studio (`select id from public.agents where name = 'Colabora Reviewer';`) or the `{agent_id}` response from `agent-admin` when creating it. Settings > Agents does not put the id in the URL. Set `AGENT_REVIEWER_AGENT_ID=<uuid>` in the Lead's `agent/.env.colabora` so it can delegate review tasks.

Create `agent/.env.reviewer` with:

```text
MODEL_BASE_URL=<Baseten OpenAI-compatible base URL ending in /v1>   # from the Baseten model page; run the same curl check with the model id below
MODEL_API_KEY=<Baseten API key>
MODEL_NAME=meta-models/muse-spark-open-1026
MODEL_PRICE_IN=0.60
MODEL_PRICE_OUT=2.40
WORKSPACE_MCP_URL=https://<project-ref>.supabase.co/functions/v1/mcp
WORKSPACE_AGENT_PAT=agt_...                                          # the reviewer's token
AGENT_HARNESS_NAME=colabora-reviewer
AGENT_MAX_TURNS=20
```

Run it with `node agent/index.mjs --env agent/.env.reviewer`. Files named `.env*` are ignored by git.

## Notifications

Without `TELEGRAM_BOT_TOKEN` events are printed to the console. With it, the bot messages the owner chat when a task is claimed, when a decision is waiting (with a link to the task in the app) and when work is delivered. Decisions are always taken in the app. `/status` in the owner chat answers with what the agent is doing.

With `AGENT_INBOX=1` the platform agent also listens. Text and voice notes from the owner's private chat become messages in the workspace, in order. A voice note is converted with `ffmpeg` and sent to `voice-transcribe`; the audio is not kept here or there. A forwarded message is data: it can be read and answered, and it never acts. "Guarda en notas" and "save in notes" reach the agent's save skill, and the server checks the person's message before writing. `/deshacer` or `/undo` takes the last note back without a model.

## Other harnesses

Any harness that speaks MCP connects to the same server and follows the same task flow; see `connect/`.

## Tests

`npx vitest run tests/agents/agentLoop.test.ts` runs the loop against `agent/test/stub-model.mjs` (a local scripted chat completions server) and `agent/test/stub-mcp.mjs` (an in-memory workspace). No network calls.

### Verified Telegram transport

`TELEGRAM_TRANSPORT=polling` remains the default and cannot decide approvals. With `webhook`, the platform agent takes `channel_updates` through MCP, delivers them to the existing inbox, and acknowledges only after delivery. Text and ffmpeg voice handling are unchanged. Queue/status tools are hidden from the model. The runtime suppresses legacy owner-chat notices in webhook mode; the server sends each notice to the linked task owner.

The webhook signing secret is server-only. Register it in a separate setup process with `node agent/telegram-webhook.mjs`; do not put it in the runtime environment. `/status` reports person-scoped saved work; `/pending` asks the server to resend current notices. Confirmations and expiry/permission checks happen on the server with the linked human identity, not the runtime token.
