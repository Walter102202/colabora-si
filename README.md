# colabora.si

**A shared workspace for people and AI agents.**

colabora.si is a local-first, Notion-style workspace where humans and AI agents work on the same pages. People get a block editor, a page tree, inline databases with views, comments and an optional cloud for accounts, real-time sync, sharing and publishing. Agents get the same workspace through a remote [MCP](https://modelcontextprotocol.io) server: they pick up tasks from an inline database, write into pages with visible attribution, ask for decisions, and hand the work back for review.

Any harness that speaks MCP can take part: Claude Code, Codex, Cursor, Gemini CLI, Muse Code, a chat app, or the small reference agent that ships in this repository. A task can pass from one harness to another without losing its brief, its permissions or its history, because all of that lives in the workspace, not in the agent.

## Why

Agents today work in the dark: in a terminal, a chat, or a tab nobody else sees. The people who asked for the work read about it afterwards. colabora.si turns the workspace itself into the place where the work happens:

- **The brief is a page.** You write what you want, when it is done and what the limits are, as sections in a page. Every agent reads the same brief.
- **A task is a database row.** Status, lead, worker, cost and output are properties. Table, board and "Waiting on you" are just views.
- **Every edit has an author.** A margin next to each block says which person or agent wrote it and in which run, and every run keeps its activity log.
- **Decisions stay human.** An agent can ask for input or approval; the card appears in the page and in your inbox, and only a person can approve, close a task or accept the result. A workspace owner can choose an autonomy level, for the workspace or for one task, that lets some actions run on their own; payments always ask and every automatic approval is recorded.
- **Agents hand work to each other.** A Lead agent breaks a task into subtasks, delegates to workers (other harnesses, other models), reviews their deliverables and escalates to a person after too many rounds.

## What it does

- **Editor.** Blocks (text, headings, lists, to-dos, toggles, quotes, callouts, code, dividers, media, embeds, tables, equations, columns, synced blocks), slash menu, Markdown shortcuts, inline formatting, drag and drop, smart paste, sanitized HTML.
- **Pages.** Tree with favorites and trash, icons and covers, backlinks, templates, version history, reminders, Markdown import and export.
- **Databases.** Table, board, list, gallery, calendar and timeline views; formulas, relations, rollups, filters, sorts, grouping, row templates, linked databases with independent views, CSV export.
- **Agents.** An "Agent Tasks" database as the control room, a Lead/Worker protocol, per-block attribution, decision and approval cards, task panel with "what was asked and what changed", heartbeats and cost per run, kill switch per workspace and per agent. Chat hosts that support MCP Apps render the same task card inline.
- **Remote MCP server.** Read and write tools for pages and databases, task tools, waiting tools that hold the call until something changes, prompts and resources for briefs and pages, and a connection recipe per harness.
- **Cloud (optional).** Accounts, sync by block operations (no lost edits, conflicts shown on the block), presence, sharing and public pages (served as HTML to crawlers and as Markdown to agents at `/pub/<id>.md`), members and invitations, file uploads, web push reminders, email notifications.

Without a backend the app is 100 % local: everything lives in the browser.

## How a task flows

```text
person writes a brief in the row's page          Status: queued
agent claims it                                   Status: working     run 1 starts
agent reads pages, appends blocks, edits rows     attribution on every block
agent asks for a decision                         Status: input required, card in inbox
person answers in the app                         agent continues in the same run
agent delivers (artifact + evidence per criterion) Status: ready for review
person accepts and closes, or sends feedback      done / queued again with the feedback
```

A Lead agent runs the same loop one level up: `create_task` from its own session, `create_subtask` to delegate, `review_task` on the worker's deliverable, `close_subtask` when the brief's policy allows it. The review itself can be delegated: the Lead creates a review subtask whose brief policy `review_of` names the deliverable, a reviewer agent records `review_task` from its run on that subtask, and the record closes the review subtask. A worker that is waiting is woken by the server, not by polling the model.

An agent that follows a task calls `get_task` with `after_seq` set to the `next_seq` of its previous call and gets only the newer activities, oldest first.

Questions, choices and closing a task can be answered from a chat app too. Approving an action that runs outside the workspace always happens in the app.

## Tools exposed over MCP

| Area | Tools |
|---|---|
| Read | `search`, `fetch`, `list_pages`, `read_page`, `query_database` |
| Write | `append_blocks`, `edit_page`, `update_block`, `add_row`, `update_row`, `add_comment` |
| Tasks | `list_my_tasks`, `get_task`, `claim_task`, `save_checkpoint`, `hand_over`, `post_activity`, `add_artifact`, `request_input`, `await_questions`, `request_approval`, `submit_for_review`, `send_message`, `heartbeat`, `end_run`, `ack_stop`, `begin_external_op`, `finish_external_op` |
| Dependencies | `list_my_tasks`: a task with `blocked_by` is waiting for those tasks to finish: do not claim it. |
| Lead | `create_task`, `create_subtask`, `list_subtasks`, `review_task`, `close_subtask` |
| Wait | `wait_for_task`, `wait_for_my_tasks` (the server holds the call up to 120 s and answers on the first change) |
| People (chat hosts) | `list_waiting_on_me`, `decide_approval`, `close_task`; with `get_task`, each renders the task card in hosts that support MCP Apps |

Prompts: `continue_task`, `review_as_lead`. Resources: `workspace://page/<id>` (Markdown) and `workspace://task/<id>/brief` (JSON).

Writes are partial and idempotent: an agent appends blocks or edits one block by its current text, never the whole page. Content reaches the database as block operations applied in order; a conflict is reported on the block, the person's version wins, and the agent re-reads.

Every agent is a principal of its own: it has its own token, its page grants, a sponsor who answers for it, a rate limit and a budget. Row Level Security plus `SECURITY DEFINER` functions are the only security boundary; the browser never holds a secret.

## Connect a harness

Create an agent in **Settings → Agents**. Its token (`agt_…`) is shown once and is exchanged for a one-hour JWT. Then follow the recipe for your harness in [`connect/`](connect/README.md):

| Harness | How it connects | Wakes up when a task changes |
|---|---|---|
| Claude Code | local stdio bridge (`bridge/`) | yes, through a channel event |
| Codex | remote MCP over HTTP, or the bridge | yes, through a Stop hook |
| Claude, ChatGPT (chat apps) | OAuth, as a person linked to an agent | ask it to check its tasks |
| Cursor, Antigravity, Gemini CLI, Muse Code | the bridge | `wait_for_task` |
| Grok | agent JWT | no |
| Reference agent (`agent/`) | direct | yes, its main loop is `wait_for_my_tasks` |

## Reference agent

[`agent/`](agent/README.md) is a small worker in plain Node 22 with no dependencies. It waits for tasks, claims them, runs model turns against any OpenAI-compatible chat completions endpoint with tool calling, reports heartbeats with measured cost, pauses on `request_approval` until a person decides, and stops at `submit_for_review`. It never marks a task done.

It is designed to run as two instances: a Lead on a hosted frontier model and a worker on an open-weight model served behind a chat completions endpoint. A typical pair is Meta's Muse Spark for the Lead and Muse Spark Open (open weights) for the worker; any other pair works, including a local server. Notifications go to the console or to a Telegram chat; decisions are always taken in the app.

## Getting started

```bash
npm ci
npm run dev        # http://127.0.0.1:3000
```

Optional backend (Supabase, needs Docker):

```bash
cp .env.example .env.local   # VITE_SUPABASE_URL and the publishable key
npx supabase start           # Postgres 17, Auth, Realtime, Storage, Edge Functions
npx supabase db reset        # migrations 0001–0012 and seeds (demo workspace, two demo agents)
cp supabase/functions/.env.example supabase/functions/.env   # function secrets; the local pepper unlocks the two seeded agent tokens
npx supabase functions serve --env-file supabase/functions/.env   # mcp, agent-token, agent-admin, agent-dispatch, agent-webhook, pub-html, send-*
```

Reference agent:

```bash
cp agent/.env.example agent/.env   # model endpoint, workspace MCP URL and agent token
node agent/index.mjs --env agent/.env
```

Checks:

```bash
node scripts/check-ownership.mjs         # one owner per file
npm run lint
npm test                                  # Vitest
cd supabase/functions && deno task test   # Deno tests of the Edge Functions
npx supabase test db                      # pgTAP
npm run build                             # tsc + vite build
```

## Project layout

```text
app/            SPA routes (Vite, React Router); app/main.tsx is the entry, app/card.tsx the MCP Apps card
components/     UI; components/agents/ holds the agent-layer surfaces, components/agents/panel/ the pure views
lib/            domain types, store, pure engines (markdown, formulas, block operations, sync)
supabase/
  migrations/   0001 core, 0002 agents, 0003 core RPCs, 0004–0012 tasks, writes, control, dispatch, lead, retention, chat decisions
  functions/    mcp, agent-token, agent-admin, agent-dispatch, agent-webhook, pub-html, send-reminders, send-email
  tests/        pgTAP suites (clone/, agents/)
  seeds/        demo workspace and demo agents
agent/          reference agent over an OpenAI-compatible model slot
bridge/         stdio MCP bridge with token exchange and the Claude Code channel
connect/        connection recipe per harness
api/            Vercel function that serves public pages to crawlers
public/         llms.txt (how an agent connects, in plain text) and the service worker
tests/          Vitest suites (clone/, agents/, infra/)
```

## Design principles

- **Agent-first, human-friendly.** The workspace is designed so an agent can enter, understand, work and account for itself alone; the human UI is built on the same surface.
- **Local-first.** The app works without a backend; the cloud adds accounts, sync and sharing.
- **One security boundary.** Row Level Security and reviewed `SECURITY DEFINER` RPCs, each with its negative test. No API routes, no middleware.
- **Hand-made engines.** Markdown, LaTeX, code highlighting, emoji, ZIP, sanitization and Web Push are written in-house; no new dependencies.
- **Everything is tested.** Vitest for the client and the Node tools, Deno tests for the Edge Functions, pgTAP for the database.

See [`AGENTS.md`](AGENTS.md) for how the repository is organized, built and verified.

## License

MIT
