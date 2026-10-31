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
- **AI in the workspace.** AI properties: a database column whose cells Colabora fills with Muse Spark when you ask, with every value signed and undoable. Agents rewrite a selected block with attribution and an Undo action, take a task when mentioned in a comment, and read attached text and PDFs under page permissions.
- **Agents.** An "Agent Tasks" database as the control room, a Lead/Worker protocol, per-block attribution, decision and approval cards, a Home with what is waiting on you, task panel with "what was asked and what changed", handover between harnesses from the last checkpoint, revert for a whole run, heartbeats and cost per run, metrics per agent, kill switch per workspace and per agent. Chat hosts that support MCP Apps render the same task card inline.
- **Remote MCP server.** Read and write tools for pages and databases, task tools, waiting tools that hold the call until something changes, prompts and resources for briefs and pages, and a connection recipe per harness.
- **Cloud (optional).** Accounts, sync by block operations (no lost edits, conflicts shown on the block), presence, sharing and public pages (served as HTML to crawlers and as Markdown to agents at `/pub/<id>.md`), members and invitations, file uploads, web push reminders, email notifications.

Without a backend the app is 100 % local: everything lives in the browser.

## Built on Muse

Any model can take part, and Meta's Muse models run the agents that ship with the product:

- **Colabora**, the workspace's platform agent, runs on Muse Spark 1.3. It leads tasks, fills AI properties and rewrites selected blocks.
- **The reviewer** runs on Muse Spark Open, the open-weight model, served by Baseten. It checks deliverables against the brief.
- **Muse Code** joins as a harness through the bridge.

Colabora and the reviewer are instances of the reference agent; [`agent/README.md`](agent/README.md) has their setup.

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

Pass `reviewer` to `create_task` to open a review task automatically for each child delivery. `submit_for_review` returns its `review_task_id`; the worker ends its turn and the Lead waits for the verdict (`under_review`). The reviewer uses `review_delivery` from its own review-task run. From the second round, it confirms the pending findings; minor findings stay available for follow-up. `lease_minutes` sets the silence limit for a run (30-1440, default 120).

An agent that follows a task calls `get_task` with `after_seq` set to the `next_seq` of its previous call and gets only the newer activities, oldest first.

Questions, choices and closing a task can be answered from a chat app too. Approving an action that runs outside the workspace always happens in the app.

### Development loop

The Lead uses `import_plan` to create subtasks in dependency order and `update_subtask` to correct their versioned briefs or delegates. It reserves each environment with `reserve_environment`; the worker reads those resources in `get_task`. Closing a task releases its migration numbers and tells the Lead which processes need shutdown. Only after stopping them does the Lead call `release_environment`.

Delivery opens the policy review automatically. Blocking findings return to the worker, minor findings stay with the review and reach the Lead, and the next review only confirms the pending corrections. A person can enable **Merge when the review is approved and CI is green** on the parent. The server checks the current delivery and brief when approval is requested and again when the external operation begins. If the conditions fail, a person decides. Pending actions can be selected and decided together; each keeps its own approval receipt and error.

For Codex Desktop, run [`connect/codex/watch.mjs`](connect/codex/README.md#waking-a-codex-desktop-session) outside the session. It carries feedback to the `external_session_id` recorded by that agent's latest run, without copying text between windows. Use the watcher or the Stop hook, never both. An idle Desktop test is covered; busy threads and closed Desktop require separate verification.

Conditional merges require `repo` and `head_sha` in both `request_approval` and `begin_external_op`, matching the newest reviewed delivery and its green CI. The executor must use `gh pr merge --match-head-commit <sha>` so a changed remote head cannot be merged using an older approval. Chat reviews and self-reviews never authorize conditional effects.

With a seeded, served local stack and its public key in `.env.local`, set `P11_TEST_THREAD_ID` to a dedicated disposable Codex test chat, then run `node tests/agents/loop-e2e.mjs`. Its fifteen checks use four seed agents and the seed owner over real MCP HTTP and SQL, including active reassignment and a Lead without a bridge. The real watcher runs through a Node-based fake CLI, captures exactly one correction and checks restart deduplication; it never queues a real Codex message. Self-review and a new unreviewed green commit both wait for a person. The final step opens an external operation for the exact reviewed commit. CI evidence and reservations are synthetic; no merge, deployment or GitHub call is performed.

## Tools exposed over MCP

| Area | Tools |
|---|---|
| Read | `search`, `fetch`, `list_pages`, `read_page`, `query_database` |
| Write | `append_blocks`, `edit_page`, `update_block`, `add_row`, `update_row`, `add_comment` |
| Tasks | `list_my_tasks`, `get_task`, `claim_task`, `save_checkpoint`, `hand_over`, `post_activity`, `add_artifact`, `request_input`, `await_questions`, `request_approval`, `submit_for_review`, `send_message`, `heartbeat`, `end_run`, `ack_stop`, `begin_external_op`, `finish_external_op` |
| Dependencies | `list_my_tasks`: a task with `blocked_by` is waiting for those tasks to finish: do not claim it. |
| Learning | `get_context_package`, `cite_lesson`, `propose_lesson`, `declare_sources`: lessons people accepted reach the next agent, each with why it is there |
| AI requests | `get_ai_request`, `fill_ai_cells`, `complete_ai_request`, `complete_lesson_request`, `report_source_check`: the platform agent's loop calls them; writes from other runs return `not_a_request_run`. |
| AI rewrite | `apply_ai_rewrite`: the platform loop rewrites the selected block with attribution and an Undo action; other runs get `not_a_request_run`. |
| Comment tasks | A person's @agent mention creates a task when the page has no open work task. `add_comment` accepts `parent_id` to reply in the same thread; an agent's mention never creates work. |
| Files | `read_file` reads attached text (2 MB) and PDF text layers (5 MB) under page permissions, with at most 50,000 characters per reply. The platform loop can extract scans/images once with a compatible model and cache them through `save_file_text`. The built-in PDF reader supports content/object streams, FlateDecode and ToUnicode; other filters and Form XObjects are outside its supported subset. |
| Lead | `create_task`, `create_subtask`, `import_plan`, `update_subtask`, `list_subtasks`, `review_task`, `close_subtask` |
| Environment | `reserve_environment`, `release_environment`, `list_environments` |
| Wait | `wait_for_task`, `wait_for_my_tasks` (the server holds the call up to 120 s and answers on the first change) |
| People (chat hosts) | `list_waiting_on_me`, `decide_approval`, `close_task`; with `get_task`, each renders the task card in hosts that support MCP Apps |

Prompts: `continue_task`, `review_as_lead`, `review_delivery`. Resources: `workspace://page/<id>` (Markdown) and `workspace://task/<id>/brief` (JSON).

Writes are partial and idempotent: an agent appends blocks or edits one block by its current text, never the whole page. Content reaches the database as block operations applied in order; a conflict is reported on the block, the person's version wins, and the agent re-reads.

Every agent is a principal of its own: it has its own token, its page grants, a sponsor who answers for it, a rate limit and a budget. Row Level Security plus `SECURITY DEFINER` functions are the only security boundary; the browser never holds a secret.

## Connect a harness

Create an agent in **Settings → Agents**. Its token (`agt_…`) is shown once and is exchanged for a one-hour JWT. Then follow the recipe for your harness in [`connect/`](connect/README.md):

| Harness | How it connects | Wakes up when a task changes |
|---|---|---|
| Claude Code | local stdio bridge (`bridge/`) | yes, through a channel event |
| Codex | remote MCP over HTTP, or the bridge | yes, through a Stop hook |
| Claude, ChatGPT (chat apps) | OAuth, as you or as an agent you choose | ask it to check its tasks |
| Cursor, Antigravity, Gemini CLI, Muse Code | the bridge | `wait_for_task` |
| Grok | agent JWT | no |
| Reference agent (`agent/`) | direct | yes, its main loop is `wait_for_my_tasks` |

## Connect a chat

Add the MCP endpoint as a connector in Claude or ChatGPT and sign in. At `/oauth/consent`, first choose the identity, then review the app and its full destination: the app chooses its own display name. **As an agent** issues the agent's own Auth token and uses its page grants, with edits attributed to the agent, via chat. Only a current member who sponsors the agent or owns the workspace can connect it; the system platform agent cannot be linked. **As you** grants your full account session and is limited to exact HTTPS return hosts `claude.ai` and `chatgpt.com` in `TRUSTED_HUMAN_HOSTS`.

In **Settings → Agents → Connected apps**, **Disconnect** immediately blocks the OAuth link in the Data API, MCP, Storage and Realtime, and revokes its Auth grant. Disconnect cuts access, but does not undo changes an **As you** session already made to the account, such as changing its password. Missing, deleted-workspace, hidden-client and former-member links fail closed. Auth sees the native agent subject; the hook does not substitute identities. An OAuth session remains OAuth after MFA: if Auth omits its client id, its authentication history identifies it and access is denied, including in **As you** mode. Agent credentials are frozen: a chat cannot change the password, email or phone, or add MFA factors, passkeys or provider identities. **Rotate login** is the service-authorized password exception: a private, single-use ticket expires after 30 seconds and permits only the prepared password. Existing direct harness JWTs still last until expiry after Rotate login; chat tokens remain subject to their live link on every RLS check. Local Auth enables TOTP so the smoke exercises this boundary and verifies that direct human MFA still works.

For a hosted setup, enable the Supabase OAuth server with `/oauth/consent` and dynamic registration, set Auth's Site URL to the app's public origin, and allow that consent URL as a sign-in redirect.

## CI evidence

A workspace owner connects `owner/name` in **Settings → Agents → Continuous integration** and runs the displayed `gh` command with their GitHub access. The app only prepares the command. Set `CI_WEBHOOK_PEPPER` to a long random secret on the backend before connecting a repository; the webhook verifies GitHub's signature before reading a delivery.

Use a criterion such as `{"id":"ci","text":"CI is green","check":"ci","command":"check"}`. The check name is exact. Deliver a `diff` artifact whose `ref` is `owner/repo@<40-character sha>` or `https://github.com/owner/repo/commit/<40-character sha>`, and include the criterion id in `satisfies`.

`get_task.ci_checks`, the task panel and the chat card show GitHub's result and its link. Only `success` passes; the newest run of the named check on the latest delivered commit decides, and it must finish after the task was created. CI still needs a current `verified` review by someone other than the artifact author before an agent can close the subtask, including when the parent permits Lead closure: a branch can change its own workflow. An agent cannot remove a CI criterion or change its id, check type or GitHub check name; a person can. Disconnecting the repository invalidates its evidence. Check runs currently have no scheduled retention cleanup.

## Reference agent

[`agent/`](agent/README.md) is a small worker in plain Node 22 with no dependencies. It waits for tasks, claims them, runs model turns against any OpenAI-compatible chat completions endpoint with tool calling, reports heartbeats with measured cost, pauses on `request_approval` until a person decides, and stops at `submit_for_review`. It never marks a task done.

It is designed to run as two instances: a Lead on a hosted frontier model and a worker on an open-weight model served behind a chat completions endpoint. A typical pair is Meta's Muse Spark for the Lead and Muse Spark Open (open weights) for the worker; any other pair works, including a local server. Notifications go to the console or to a Telegram chat; decisions are always taken in the app.

## Getting started

You need Node 22. The optional backend also needs Docker, and the Edge Function tests need Deno 2.

```bash
npm ci
npm run dev        # http://127.0.0.1:3000
```

Optional backend (Supabase):

```bash
npx supabase start           # Postgres 17, Auth, Realtime, Storage, Edge Functions
cp .env.example .env.local   # set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY; `npx supabase status` prints both
npx supabase db reset        # migrations and seeds (demo workspace, four demo agents)
cp supabase/functions/.env.example supabase/functions/.env   # set AGENT_LOGIN_PEPPER=local-dev-login-pepper to unlock the four seeded agent tokens
                                                              # and MCP_AUTH_SERVER_URL=http://127.0.0.1:54321/auth/v1 so the mcp function accepts tokens from the local Auth
npx supabase functions serve --env-file supabase/functions/.env   # mcp, agent-token, agent-admin, agent-dispatch, agent-webhook, github-webhook, pub-html, send-*
```

Restart `npm run dev` and sign in as `owner@demo.local`; the password is in `supabase/seeds/01_workspace.sql`.

Reference agent:

```bash
cp agent/.env.example agent/.env   # model endpoint, workspace MCP URL and agent token
node agent/index.mjs --env agent/.env
```

Checks:

```bash
node scripts/check-ownership.mjs         # one owner per file
npm run lint
TZ=UTC npm test                           # Vitest
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
  migrations/   numbered SQL, one concern per file: core, agents, tasks, writes, control, dispatch, Lead, decisions, metrics, AI, OAuth, CI evidence
  functions/    mcp, agent-token, agent-admin, agent-dispatch, agent-webhook, github-webhook, pub-html, send-reminders, send-email
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
