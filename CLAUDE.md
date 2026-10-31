# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) is the guide shared by every coding agent: stack, folders, run and verify commands, conventions, contracts and the "do not" list. Read it first. This file adds what is not written there: the commands that are easy to get wrong and the architecture that only shows up when you read several files together.

## Commands beyond AGENTS.md

One test per runner:

```bash
npx vitest run tests/agents/bridge.test.ts -t "<test name>"                          # Vitest (PowerShell: $env:TZ="UTC"; npx vitest run ...)
cd supabase/functions && deno test --allow-env --allow-net --allow-read _shared/tools/wait.test.ts   # Deno, one file
npx supabase test db supabase/tests/agents/07_approvals.sql                             # pgTAP, one file (stack up, db reset done)
```

- Vitest suites live in `tests/clone/` (track B), `tests/agents/` (track A) and `tests/infra/`. The default environment is `node`; a suite that touches the DOM starts with `// @vitest-environment happy-dom`.
- `npm run build` runs two Vite entries: `index.html` (the workspace) and `apps/card.html` (the MCP Apps card).
- `npm run build:card` regenerates `supabase/functions/_shared/cardHtml.ts` from the card entry. Run it after any change under `components/agents/card/` or `components/agents/panel/` and commit the generated file; a deploy never builds it.
- Card without a chat host: `http://127.0.0.1:3000/apps/card.html?mock=<scenario>` (scenarios in `components/agents/card/mock.ts`).
- Three checks run only against a served local stack and are not part of `npm test`: `node tests/agents/mcp-smoke.mjs` (needs `MCP_URL`, `AGENT_PAT`, `SMOKE_PAGE_ID`), `tests/agents/sql-concurrency.test.ts` (skips unless `A_DB_URL` is set), and `node tests/agents/loop-e2e.mjs` (reads the local URL/public key from `.env.local`, uses all four seed agents and the seed owner). The loop script refuses hosted endpoints, uses only this checkout's configured database container and performs no real merge, deployment or message to Codex. The seed credentials work only with the local pepper; never print them.
- `scripts/check-ownership.mjs` counts untracked files too, and skips (exit 0) on `main` or on any branch without an `a/`, `b/` or `infra/` prefix. CI runs it on every push with `--base origin/main`.
- `main` deploys: the CI job pushes migrations and deploys Edge Functions from `main` only, and only when the Supabase secrets are configured.

## Architecture

### What agents learn

A correction (review, feedback, rejected close) opens a `lesson` request for the platform agent, through triggers that can never fail it. A proposal is inert until a person accepts it from a direct session. `claim_task` adds a `context_package` from `task_context`: accepted lessons, decisions of the same context, sources and related pages, each with its reason. A page keeps its sources in `page_sources` with a fingerprint; a change marks the dependents and `source_tick` opens a `source_check` request after a quiet window. A check only reports: a contradiction opens a `page_discrepancies` row for a person, so no chain of checks can feed itself.

### Two runtimes, one domain model

- **Browser.** The workspace is a Zustand store persisted in `localStorage` (`lib/store.ts`); every mutation is a store action that returns new objects, built on the pure modules `lib/pageMutations.ts` and `lib/dbMutations.ts`. Without `VITE_SUPABASE_URL` the store is the whole product and `getSupabase()` returns `null`; every cloud surface treats that as "no backend".
- **Supabase.** With a backend, Postgres is the source of truth and the store is a replica kept live by Realtime. Edge Functions run in Deno and can only import what lives under `supabase/functions/`, so the pure modules they share with the app (`types`, `agentInput`, `dbCompute`, `dbFilter`) are byte-for-byte copies in `supabase/functions/_shared/lib/` with imports rewritten to relative paths. `tests/agents/functionsSharedSync.test.ts` fails when a copy drifts: change the source in `lib/`, then recopy. The sources belong to track B and the copies to track A.

### The write path: block operations, never whole pages

- A page change is a list of `PageOp` (`lib/pageOps.ts`: `applyOps`, `diffPageToOps`). The client's `PageSyncEngine` (`lib/sync.ts`) queues ops per page in IndexedDB (`lib/opsQueue.ts`), debounces, sends them to the `apply_page_ops` RPC and receives one result per op. Realtime rows that carry this client's `_client` tag are echoes and are ignored; others are rebased over the pending ops.
- Conflicts are per block (`Block.rev`), never per page: the person's version wins, the other version is shown on the block (`lib/syncConflicts.ts`), and an agent gets `block_conflict` and re-reads. The `pages_20_revision` trigger (migration 0001) rejects any direct update of `pages.data` with `PT403 use_apply_page_ops`, so there is no other way in.
- Agents enter through the same core. The MCP write tools accept Markdown or `AgentBlockInput` spans (`lib/agentInput.ts`), never HTML or `Block` objects; the partial-write RPCs (migration 0005) build escaped HTML in SQL, filter every href, and call `private.apply_page_ops_core`. While a run is active, every write also leaves an `action` activity carrying the inverse ops.

### One security boundary

- No API routes, no middleware, no secrets in the browser. Row Level Security plus `SECURITY DEFINER` RPCs with an empty `search_path` are the boundary; each RPC repeats its own access check and has a negative pgTAP test in `supabase/tests/`.
- People and agents are both auth users. An agent is an `agents` row plus an auth user whose password is derived from `AGENT_LOGIN_PEPPER`; its personal access token (`agt_…`) is exchanged at `agent-token` for a one-hour JWT. Agent OAuth reads/decisions run in `agent-admin` as that same agent Auth user, after direct-person, sponsor/owner and current-membership checks. `_shared/jwt.ts` preserves the signed principal; the 0029 hook validates an explicit live client link and adds only `via_user`. It never substitutes identity, and missing/orphaned/former-member links fail closed. `current_agent_id()` checks the same link for Storage and Realtime RLS, without an OAuth lookup for direct tokens. SQL `jwt_client_id()` and the shared Edge `oauthClientId()` preserve OAuth origin through the `oauth_provider/authorization_code` AMR method when MFA omits client_id; unresolved OAuth tokens are denied, including through human membership/editor/share RLS. Auth sees the native agent subject. A trigger freezes agent password, email and phone (including pending changes); Rotate login prepares a service-only, encrypted, one-use password ticket with a 30-second deadline before the Auth update. The ticket cannot authorize a chat-chosen password. Separate insert triggers reject agent MFA factors, WebAuthn credentials and provider identities without exceptions. As-you consent accepts only the single `TRUSTED_HUMAN_HOSTS` HTTPS policy; its token is a full human session. All chat tokens are rejected by `agent-admin` and PAT issuance. The metadata RPCs read Auth OAuth tables without binding a pending authorization, so remembered consent can be linked safely before returning its code. TOTP enrollment and verification are enabled locally and covered by the real smoke.
- The `mcp` function builds a supabase-js client with the caller's own token (`callerClient`), so RLS decides every read and write. The service role appears in `agent-admin` (after the caller's RLS check), `agent-dispatch`, the `send-*` functions, `voice-transcribe` (only to record what the provider answered, after `voice_reserve` runs as the caller), and `github-webhook` after checking the signature over the raw GitHub delivery.
- `decide_approval`, `close_task` (which carries the acceptance) and `revoke_agent` are `humans_only`; an agent calling them gets that error.

### The task model

- Migration 0004 holds the work model: `agent_tasks`, `task_briefs`, runs, append-only `agent_activities`, artifacts, approvals, reviews, external operations, the `agent_events` outbox and the audit log. None of these tables has an insert, update or delete policy: state is written only by the control RPCs (0006) and derived by triggers from activities (0007). `agent_tasks.state` is never written by a client.
- States: `queued → working → input_required | ready_for_review → done | failed | cancelled`. `lib/agentState.ts` is a pure mirror of the server's transition table used to predict and explain state in the UI; the server stays authoritative.
- The brief is the row's page: sections keyed by `Block.key` (`brief:goal`, `brief:done_when`, `brief:constraints`, `brief:sources`). `task_briefs` stores derived versions. `briefFromRow` in `lib/agentActions.ts` reads those keys and `briefBlocks` in `_shared/tools/lead.ts` writes them, so the keys in `lib/agentTasksTemplate.ts` (the "Agent Tasks" database template) are a contract between the two.
- The Lead role (0009) is a role any agent can hold: `create_task`, `create_subtask`, `review_task`, `close_subtask`. `close_subtask` succeeds only by brief policy or a verified deterministic check; CI criteria additionally require a current verified review and a passing GitHub check (0030), even under a Lead closure policy. Everything else is closed by a person.
- Write and task tools take an idempotency key. Every agent RPC calls `private.check_rate` first (per-agent rate limit); the monthly budget is checked when a task is created or delegated (`budget_exceeded`) and rolled up hourly (migration 0010).

### The MCP server

- `supabase/functions/_shared/mcp.ts` is a hand-written Streamable HTTP server: one POST endpoint, JSON responses only, no SSE, no session state, both protocol eras (2025 and 2026). `supabase/functions/mcp/server.ts` assembles the server from `_shared/tools/{read,write,tasks,handover,wait,lead,lessons,sources,context,ai,card}.ts` plus the prompts, resources and instructions in `_shared/tools/prompts.ts`.
- A tool is a `ToolDef` (name, input and output JSON schema, annotations, handler). Handlers validate, call RPCs through the narrow `Db` interface in `_shared/db.ts`, and return `{text, structured}`. Tests replace `Db` with an in-memory fake, so tool tests run without a database (see `tools/*.test.ts`).
- Wait tools (`wait_for_task`, `wait_for_my_tasks`) hold a call for up to 120 s under RLS. An empty iteration costs one select on `agent_events` (backoff from 1.5 s to 10 s); a full snapshot runs on a fresh event, at least every 10 s and at the deadline. They return a cursor that is evaluated before sleeping, so nothing is lost between calls.
- `agent-webhook` runs the same `ToolDef`s for push agents, so validation and errors match the MCP path.
- To add a tool: define it in the matching tools module, append it to the array in `server.ts`, write the Deno test next to it, and update the tool table in `README.md` and `public/llms.txt`.

### How harnesses learn that a task changed

- Every change lands in the `agent_events` outbox (0008). From there: Realtime channel `agent-<agent_id>` (the bridge listens), a pgmq queue drained by `agent-dispatch` into signed CloudEvents for webhook agents, or simply marked delivered by the next `wait_for_my_tasks` or `list_my_tasks` call of a pull agent.
- `bridge/` is a stdio MCP proxy for local harnesses: it exchanges the PAT for a JWT, retries once on 401, forwards every request, and emits `claude/channel` notifications that wake an idle Claude Code session. `connect/codex/on-stop.mjs` is a Codex Stop hook that waits outside the model (through `bridge/remote.mjs`) and continues the session with `{"decision":"block"}`. `agent/loop.mjs` drives the runtime tools itself (`RUNTIME_TOOLS` are hidden from the model) and exposes the rest as OpenAI-style tools.
- `bridge/`, `agent/` and `connect/` are plain Node 22 `.mjs` with `.d.mts` typings, excluded from `tsc` and ESLint, and tested from Vitest in `tests/agents/` (`bridge.test.ts`, `agentLoop.test.ts` against `agent/test/stub-model.mjs` and `stub-mcp.mjs`, `connect-codex-hook.test.ts`).

### The agent layer inside the web app

- Track B mounts track A only through the plugs listed in `AGENTS.md`. `AgentPropertyCell` renders the computed `agentStatus` and `agentDelegate` property types (never stored in cells). `RowPanel` mounts under a database row's page, reads `?task=<id>` and `#approval-<id>` from the URL, and is the only connector: it loads and subscribes (`lib/agentTasks.ts`, a non-persisted store kept live by Realtime), calls the control RPCs as the person (`lib/agentActions.ts`), and hands data and callbacks to the pure views in `components/agents/panel/`. Settings → Agents uses `lib/agentsStore.ts` and the `agent-admin` function.
- The pure views render twice: in the workspace through `RowPanel`, and in the MCP Apps card.

### The MCP Apps card

- `apps/card.html → app/card.tsx → components/agents/card/main.tsx` is an isolated React root with no router, stores or Supabase. It talks to the chat host over JSON-RPC on `postMessage` (`lib/agentCardHost.ts`, written by hand to the MCP Apps specification). The data contract is `lib/agentCard.ts`: the `structuredContent` returned by `get_task`, `decide_approval`, `close_task` and `list_waiting_on_me`.
- `npm run build:card` inlines the bundle into `_shared/cardHtml.ts`, which the `mcp` function serves as the `ui://colabora/task-card.html` resource. The target is 300 KB; import less into the card if the build warns.

### Public pages and routing

- `/pub/:id` is the SPA for people. `vercel.json` routes crawler user agents to the Vercel function `api/pub.ts`, which proxies the `pub-html` Edge Function and restores the `text/html` content type the Supabase gateway strips; `/pub/:id.md` returns the page as Markdown for agents. Both renderers live in `_shared/pageToHtml.ts` and `pageToMarkdown.ts` and read through the anon client with the same `get_page_bundle` RPC the app uses, so "published" is decided in one place.
- Every URL comes from `lib/routes.ts`. `components/AppNavigation.tsx` intercepts same-origin anchor clicks so plain `<a href>` links navigate inside the SPA. Modal state (settings tab, search, peek, task) lives in query parameters, so any screen is reachable by URL.

## Working here

### P11 migrations and tools

| Migration | Behavior |
|---|---|
| 0031 | Silent-run lease and same-agent recovery. |
| 0032 | Owned environment resources; shutdown confirmation before release. |
| 0033 | Blocking/minor findings; only blocking evidence satisfies criteria. |
| 0034 | Automatic review tasks and narrower subsequent rounds. |
| 0035 | Human-authored conditions evaluated at approval and execution. |

| Tools / prompt | Notes |
|---|---|
| `import_plan`, `update_subtask` | Idempotent dependency import and versioned brief/delegate changes. |
| `reserve_environment`, `list_environments`, `release_environment` | Resources are data enforced by the server; the database does not stop processes. |
| `create_task`, `submit_for_review`, `review_delivery` | Parent reviewer policy; delivery returns `review_task_id`, and the Lead waits on `under_review`. |
| `wait_for_my_tasks` | `session_id` belongs to the latest own run, never another agent's run. |

For Desktop, `node connect/codex/watch.mjs` replaces the Stop hook and forwards task changes to that session through `codex queue`. Do not run both. Test only with a newly-created disposable chat. Conditional rules are edited in the direct app session; payment is never conditionally approved.

- The branch prefix decides which track you are on; follow the ownership rules in `AGENTS.md`. On `main` you act for the maintainer and may touch infra files.
- `tests/infra/migrationOrder.test.ts` judges gaps by the target: `main` and pull requests into it take none; a branch may skip only the numbers `OWNERS.json` reserves for a part that is not merged yet.
- Private working context lives in gitignored files (`CLAUDE.local.md`, `CONTEXTO.md`). Nothing from them goes into versioned files, commits or the README.
