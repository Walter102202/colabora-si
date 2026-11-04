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
- `npm run build:card` regenerates `supabase/functions/_shared/cardHtml.ts` from the card entry. Run it after any change under `components/agents/card/` or `components/agents/panel/`, or to a `lib/` module the card imports, and commit the generated file; a deploy never builds it and CI fails when it is stale.
- Card without a chat host: `http://127.0.0.1:3000/apps/card.html?mock=<scenario>` (scenarios in `components/agents/card/mock.ts`).
- Three checks run only against a served local stack and are not part of `npm test`: `node tests/agents/mcp-smoke.mjs` (needs `MCP_URL`, `AGENT_PAT`, `SMOKE_PAGE_ID`), `tests/agents/sql-concurrency.test.ts` (skips unless `A_DB_URL` is set), and `node tests/agents/loop-e2e.mjs` (reads the local URL/public key from `.env.local`, uses all four seed agents and the seed owner). The loop script refuses hosted endpoints, uses only this checkout's configured database container and performs no real merge, deployment or message to Codex. The seed credentials work only with the local pepper; never print them.
- `scripts/check-ownership.mjs` counts untracked files too, and skips (exit 0) on `main` or on any branch without an `a/`, `b/` or `infra/` prefix. CI runs it on every push with `--base origin/main`.
- A second local stack needs its own `project_id` and ports in `supabase/config.toml`, kept out of commits with `git update-index --skip-worktree supabase/config.toml`. `workspace-mcp-smoke.mjs` refuses to run unless that file names `colabora-si-p14` and port 60990.
- Pushing to `main` deploys. Vercel ships the frontend and the `trama` daemon right away; only `main` builds. `deploy-backend` waits for approval in the `production` environment and skips without the Supabase secrets, so a frontend that needs a new migration goes live first unless the backend ships before the push.

## Architecture

### What agents learn

A correction (review, feedback, rejected close) opens a `lesson` request for the platform agent, through triggers that can never fail it. A proposal is inert until a person accepts it from a direct session. `claim_task` adds a `context_package` from `task_context`: accepted lessons, decisions of the same context, sources and related pages, each with its reason. A page keeps its sources in `page_sources` with a fingerprint; a change marks the dependents and `source_tick` opens a `source_check` request after a quiet window. A check only reports: a contradiction opens a `page_discrepancies` row for a person, so no chain of checks can feed itself.

### Two runtimes, one domain model

- **Browser.** The Zustand store (`lib/store.ts`) is an in-memory replica. Its local copy lives in the `colabora-local` IndexedDB database, managed by `lib/localPersistence.ts`, with separate metadata, bodies, search records and small workspace settings. Every mutation remains a synchronous store action returning new objects, built on `lib/pageMutations.ts` and `lib/dbMutations.ts`. Startup reads metadata; an unloaded page is a symbol-marked shell whose empty arrays are placeholders, not content. Load required bodies with `ensurePageBodies` in `lib/pageBodies.ts` or `usePageBodies` in `lib/usePageBodies.ts`. Hydration runs inside `applyingExternal`: loading is not editing and creates no operations, history or versions. Remote downloads are cached explicitly. Without `VITE_SUPABASE_URL`, IndexedDB is the durable copy and `getSupabase()` returns `null`; unavailable storage leaves all bodies in memory with a warning.
- **Logging out.** `signOut` first sends pending edits and asks before losing any that cannot be sent. `discardLocalCopy` stops sync, clears history and the store, and calls `clearLocalPages`: an on-disk epoch rejects old writers, a persistent clear marker recovers interrupted wipes, and other tabs reload. Cached files have their own interrupted-clear barrier. Account switching uses the same cleanup before loading the new account. Recovery copies in `localStorage` and account-scoped pending shared-page operations in `colabora-sync` deliberately remain (`clearStoredOps(true)`), preserving work that has not reached the server. `SyncConflictModal` is only for pages written before signing in.
- **Undo.** Import, reset, permanent deletion and empty-trash UI actions use the loaded helpers in `lib/pageBodies.ts` to retain original bodies before changing history. Their synchronous store actions reject unloaded originals and use `historyAction` to capture a separate snapshot. Missing bodies prevent these destructive actions; account cleanup deliberately clears history instead.
- **Supabase.** With a backend, Postgres is the source of truth and the store is a replica kept live by Realtime. Edge Functions run in Deno and can only import what lives under `supabase/functions/`, so the pure modules they share with the app (the `SHARED` list in `tests/agents/functionsSharedSync.test.ts`) are byte-for-byte copies in `supabase/functions/_shared/lib/` with imports rewritten to relative paths. `tests/agents/functionsSharedSync.test.ts` fails when a copy drifts: change the source in `lib/`, then recopy. The sources belong to track B and the copies to track A.

### The write path: page operations

- A page change is a list of `PageOp` (`lib/pageOps.ts`: `applyOps`, `diffPageToOps`). The client's `PageSyncEngine` (`lib/sync.ts`) queues ops per page in IndexedDB (`lib/opsQueue.ts`), debounces, sends them to the `apply_page_ops` RPC and receives one result per op. Realtime rows that carry this client's `_client` tag are echoes and are ignored; others are rebased over the pending ops.
- `set_tree` is local-only and carries `parentId`, `isDeleted` and `rowOrigin`. Before sending it, the client reads the current server row and builds a revision-checked `replace_page` with that complete body. `set_tree` never reaches the server, and an unloaded shell never becomes a replacement or a recovery copy.
- Block edits conflict per block (`Block.rev`): the person's version wins, the other version is shown on the block (`lib/syncConflicts.ts`), and an agent gets `block_conflict` and re-reads. Full-page replacements also check the page revision; rejected local content is retained in a recovery copy before its operations are discarded. The `pages_20_revision` trigger (migration 0001) rejects direct updates of `pages.data` with `PT403 use_apply_page_ops`.
- Agents enter through the same core. The MCP write tools accept Markdown or `AgentBlockInput` spans (`lib/agentInput.ts`), never HTML or `Block` objects; the partial-write RPCs (migration 0005) build escaped HTML in SQL, filter every href, and call `private.apply_page_ops_core`. While a run is active, every write also leaves an `action` activity carrying the inverse ops.

### One security boundary

- No API routes, no middleware, no secrets in the browser. Row Level Security plus `SECURITY DEFINER` RPCs with an empty `search_path` are the boundary; each RPC repeats its own access check and has a negative pgTAP test in `supabase/tests/`.
- People and agents are both auth users. An agent is an `agents` row plus an auth user whose password is derived from `AGENT_LOGIN_PEPPER`; its personal access token (`agt_…`) is exchanged at `agent-token` for a one-hour JWT. Agent OAuth reads/decisions run in `agent-admin` as that same agent Auth user, after direct-person, sponsor/owner and current-membership checks. `_shared/jwt.ts` preserves the signed principal; the 0029 hook validates an explicit live client link and adds only `via_user`. It never substitutes identity, and missing/orphaned/former-member links fail closed. `current_agent_id()` checks the same link for Storage and Realtime RLS, without an OAuth lookup for direct tokens. SQL `jwt_client_id()` and the shared Edge `oauthClientId()` preserve OAuth origin through the `oauth_provider/authorization_code` AMR method when MFA omits client_id; unresolved OAuth tokens are denied, including through human membership/editor/share RLS. Auth sees the native agent subject. A trigger freezes agent password, email and phone (including pending changes); Rotate login prepares a service-only, encrypted, one-use password ticket with a 30-second deadline before the Auth update. The ticket cannot authorize a chat-chosen password. Separate insert triggers reject agent MFA factors, WebAuthn credentials and provider identities without exceptions. As-you consent accepts only the single `TRUSTED_HUMAN_HOSTS` HTTPS policy; its token is a full human session. All chat tokens are rejected by `agent-admin` and PAT issuance. The metadata RPCs read Auth OAuth tables without binding a pending authorization, so remembered consent can be linked safely before returning its code. TOTP enrollment and verification are enabled locally and covered by the real smoke.
- The `mcp` function builds a supabase-js client with the caller's own token (`callerClient`), so RLS decides every read and write. The service role appears in `agent-admin` (after the caller's RLS check), `trama-runtime` (after its own secret), `agent-dispatch`, the `send-*` functions, `voice-transcribe` (only to record what the provider answered, after `voice_reserve` runs as the caller), `github-webhook` after checking the signature over the raw GitHub delivery, `waitlist`, whose public caller reaches only the service-only waitlist RPCs, and `waitlist-invites`, which answers only to the dispatch secret and uses Auth only to issue an invitation link. It also appears in `agent-token` (PAT exchange), `account-link` (service-only RPCs, after its generic answer), `channel-notify` (after the dispatch secret) and `telegram-webhook` (after the secret token).
- `decide_approval`, `close_task` (which carries the acceptance) and `revoke_agent` are `humans_only`; an agent calling them gets that error.

### The task model

- Migration 0004 holds the work model: `agent_tasks`, `task_briefs`, runs, append-only `agent_activities`, artifacts, approvals, reviews, external operations, the `agent_events` outbox and the audit log. None of these tables has an insert, update or delete policy: state is written only by the control RPCs (0006) and derived by triggers from activities (0007). `agent_tasks.state` is never written by a client.
- States: `queued → working → input_required | ready_for_review → done | failed | cancelled`. `lib/agentState.ts` is a pure mirror of the server's transition table used to predict and explain state in the UI; the server stays authoritative.
- The brief is the row's page: sections keyed by `Block.key` (`brief:goal`, `brief:done_when`, `brief:constraints`, `brief:sources`). `task_briefs` stores derived versions. `briefFromRow` in `lib/agentActions.ts` reads those keys and `briefBlocks` in `_shared/tools/lead.ts` writes them, so the keys in `lib/agentTasksTemplate.ts` (the "Agent Tasks" database template) are a contract between the two.
- The Lead role (0009) is a role any agent can hold: `create_task`, `create_subtask`, `review_task`, `close_subtask`. `close_subtask` succeeds by brief policy, a verified deterministic check, or (0062) at Autonomous autonomy when an agent other than the author approved it and no criterion is human, deterministic or CI. A person's Accept on a job also closes its delivered subtasks. An agent's review counts from any session, so a Lead connected by OAuth can close; a person's chat review does not, and conditional approvals keep requiring a direct session; CI criteria additionally require a current verified review and a passing GitHub check (0030), even under a Lead closure policy. Everything else is closed by a person.
- Write and task tools take an idempotency key. Every agent RPC calls `private.check_rate` first (per-agent rate limit); the monthly budget is checked when a task is created or delegated (`budget_exceeded`) and rolled up hourly (migration 0010).
- Conditional rules are edited in the direct app session; payment is never conditionally approved.

### Jobs, roles and autonomy

- A job is a top-level row of an "Agent Tasks" database; its subtasks nest under it through `agent_tasks.parent_task_id`. `lib/agentJobs.ts` derives the board states. A subtask row written by a person stays a page until the Lead adopts it (`get_pending_job_rows`, 0059).
- The row decides a session's role, not the chat. `join_job` finds the job by name, answers `joined`, `other_lead`, `no_lead`, `ambiguous`, `not_found` or `not_assigned`, and never grants access. `assign_job` grants it on the whole database, so a chosen agent sees every job there. Claiming a subtask also counts as joining (0063).
- `set_agent_role` and `set_agent_autonomy` are for the owner, from a direct session. In `private.own_autonomy_level`, a workspace on Ask first returns `ask` for everyone, and `agents.autonomy` is a ceiling (null inherits the workspace).
- Platform agents default to one work run and three request runs (`max_active_*`, 0064). Null means unlimited, as for external agents.

### The MCP server

- `supabase/functions/_shared/mcp.ts` is a hand-written Streamable HTTP server: one POST endpoint, JSON responses only, no SSE, no session state, both protocol eras (2025 and 2026). `supabase/functions/mcp/server.ts` assembles the server from `_shared/tools/{read,write,tasks,handover,wait,lead,lessons,sources,context,ai,card,person}.ts` plus the prompts, resources and instructions in `_shared/tools/prompts.ts`; `workspace-mcp/server.ts` uses `{read,write,workspace}`.
- A tool is a `ToolDef` (name, input and output JSON schema, annotations, handler). Handlers validate, call RPCs through the narrow `Db` interface in `_shared/db.ts`, and return `{text, structured}`. Tests replace `Db` with an in-memory fake, so tool tests run without a database (see `tools/*.test.ts`).
- Wait tools (`wait_for_task`, `wait_for_my_tasks`) hold a call for up to 120 s under RLS. An empty iteration costs one select on `agent_events` (backoff from 1.5 s to 10 s); a full snapshot runs on a fresh event, at least every 10 s and at the deadline. They return a cursor that is evaluated before sleeping, so nothing is lost between calls.
- `agent-webhook` runs the same `ToolDef`s for push agents, so validation and errors match the MCP path.
- To add a tool: define it in the matching tools module, append it to the array in `server.ts`, write the Deno test next to it, and update the tool table in `README.md` and `public/llms.txt`.

### How harnesses learn that a task changed

- Every change lands in the `agent_events` outbox (0008). From there: Realtime channel `agent-<agent_id>` (the bridge listens), a pgmq queue drained by `agent-dispatch` into signed CloudEvents for webhook agents, or simply marked delivered by the next `wait_for_my_tasks` or `list_my_tasks` call of a pull agent.
- `bridge/` is a stdio MCP proxy for local harnesses: it exchanges the PAT for a JWT, retries once on 401, forwards every request, and emits `claude/channel` notifications that wake an idle Claude Code session. `connect/codex/on-stop.mjs` is a Codex Stop hook that waits outside the model (through `bridge/remote.mjs`) and continues the session with `{"decision":"block"}`. For Codex Desktop, `node connect/codex/watch.mjs` replaces the hook and forwards task changes to that session through `codex queue`; run one or the other, and test only with a newly-created disposable chat. `agent/loop.mjs` drives the runtime tools itself (`RUNTIME_TOOLS` are hidden from the model) and exposes the rest as OpenAI-style tools.
- `bridge/`, `agent/` and `connect/` are plain Node 22 `.mjs` with `.d.mts` typings, excluded from `tsc` and ESLint, and tested from Vitest in `tests/agents/` (`bridge.test.ts`, `agentLoop.test.ts` against `agent/test/stub-model.mjs` and `stub-mcp.mjs`, `connect-codex-hook.test.ts`).

### Managed Trama

`agent/fleet.mjs` is one always-on process with one `runAgent` listening per workspace. `trama-runtime` answers only to `TRAMA_RUNTIME_SECRET`: it lists the Tramas to serve, creates the one a workspace lacks and signs an agent in, so no PAT exists. Without that secret the function answers 404 and the process refuses to start, so a fork has no managed Trama and keeps Enable Trama. A workspace whose owner revoked Trama keeps that row and is not given another. On Vercel it runs as the `trama` daemon in `vercel.json`; it reads `VITE_SUPABASE_URL`, `VITE_APP_URL`, `META_MODEL_API_KEY` and `TRAMA_RUNTIME_SECRET` from the project, and `agent/` must stay self-contained because it is the build context.

The model defaults to `muse-wonder-1.0`. `agent/mcpCompose.mjs` joins the task and workspace endpoints into one client; the task endpoint wins a name collision.

Trama proposes and a person confirms. `start_proposed_work` approves exactly the summary shown, once, and validation uses the person's access, never Trama's grants (0066). Messages sent through `send_proposed_message` reach a live session on `heartbeat` or in a tool response, never through a webhook that could start another run. `agent_activities.posted` is true only for `post_activity`, so server receipts never count as an agent's reply to a person (0067).

### The agent layer inside the web app

- Track B mounts track A only through the plugs listed in `AGENTS.md`. `AgentPropertyCell` renders the computed `agentStatus` and `agentDelegate` property types (never stored in cells). `RowPanel` mounts under a database row's page, reads `?task=<id>` and `#approval-<id>` from the URL, and is the only connector: it loads and subscribes (`lib/agentTasks.ts`, a non-persisted store kept live by Realtime), calls the control RPCs as the person (`lib/agentActions.ts`), and hands data and callbacks to the pure views in `components/agents/panel/`. Settings → Agents uses `lib/agentsStore.ts` and the `agent-admin` function.
- The pure views render twice: in the workspace through `RowPanel`, and in the MCP Apps card.

### The MCP Apps card

- `apps/card.html → app/card.tsx → components/agents/card/main.tsx` is an isolated React root with no router, stores or Supabase. It talks to the chat host over JSON-RPC on `postMessage` (`lib/agentCardHost.ts`, written by hand to the MCP Apps specification). The data contract is `lib/agentCard.ts`: the `structuredContent` returned by `get_task`, `decide_approval`, `close_task` and `list_waiting_on_me`.
- `npm run build:card` inlines the bundle into `_shared/cardHtml.ts`, which the `mcp` function serves as the `ui://colabora/task-card.html` resource. The target is 300 KB; import less into the card if the build warns.

### Public pages and routing

- `/` is the landing for a visitor with no stored session on a build with a backend, and the workspace for everyone else. `app/main.tsx` decides with `lib/landingEntry.ts` before loading anything, so a visitor never downloads the workspace; URLs the app must handle (invitations, modal state, auth callbacks) go to the workspace, and `/landing` always shows the landing. Its stylesheet is scoped under `.landing` and loads only with its chunk. The waitlist lives in `private.waitlist`, reached only through the `waitlist` function. With `RESEND_API_KEY`, a new address gets one confirmation (`waitlist/email.ts`) after the answer; a row without `confirmation_sent_at` is still owed it. The Notion copy works the same way through `notion_synced_at`. Each new signup also catches up to five rows per step. Sign-up stays closed on hosted, so an account starts from an invitation: every minute `waitlist-invites` sends one to each row the owner marked `Invite` in Notion and writes `Invited` or `Invite error` back. A row with an error waits until the owner clears it. `_shared/inviteEmail.ts` gets the token from `generateLink`, which sends nothing, and mails the design through Resend, so Auth's mailer and templates play no part. The link opens `/set-password`, a page outside the workspace bundle (`components/landing/SetPassword.tsx`); it calls `verifyOtp` only on submit, because a mail scanner may open the link first. The token lasts as long as Auth's email OTP expiry (86400 seconds for the advertised 24 hours). Expired links request a replacement through `account-link`, keeping any valid workspace token. Confirmed people receive recovery links, unconfirmed existing people receive invitations, and unknown addresses/agents receive nothing.
- `/pub/:id` is the SPA for people. `vercel.json` routes crawler user agents to the Vercel function `api/pub.ts`, which proxies the `pub-html` Edge Function and restores the `text/html` content type the Supabase gateway strips; `/pub/:id.md` returns the page as Markdown for agents. Both renderers live in `_shared/pageToHtml.ts` and `pageToMarkdown.ts` and read through the anon client with the same `get_page_bundle` RPC the app uses, so "published" is decided in one place.
- Every URL comes from `lib/routes.ts`. `components/AppNavigation.tsx` intercepts same-origin anchor clicks so plain `<a href>` links navigate inside the SPA. Modal state (settings tab, search, peek, task) lives in query parameters, so any screen is reachable by URL.

### Connection onboarding

`AGENTS.md` has the rules. Public guides live at `/connect.md`. Coding clients use both the task and workspace endpoints; the ChatGPT and Claude guides use pages only. No pasted, forwarded or channel message can authorize a Trama proposal.

## Working here

- The branch prefix decides which track you are on; follow the ownership rules in `AGENTS.md`. On `main` you act for the maintainer and may touch infra files.
- A migration is `<14 digits>_<NNNN>_<snake_case>.sql`. Timestamp order must equal number order, and each number needs a `*_NNNN_*` line in `OWNERS.json`. Renumber at merge when two branches claim one number.
- `branchExceptions` in `OWNERS.json` lists the out-of-track files allowed per branch. A track branch that adds a migration needs `OWNERS.json` there.
- `tests/infra/migrationOrder.test.ts` judges gaps by the target: `main` and pull requests into it take none; a branch may skip only the numbers `OWNERS.json` reserves for a part that is not merged yet.
- Private working context lives in gitignored files (`CLAUDE.local.md`, `CONTEXTO.md`). Nothing from them goes into versioned files, commits or the README.
- Telegram decisions enter through a verified secret-token webhook and service-role RPCs, never through agent credentials. `channel-notify` uses the dispatch secret and stored approval rows. Payment, edit and close_task stay in the app. Text answers require a verified confirmation callback; no model interprets consent.

### Account email checks

Use fake Resend transport for local access tests, with public signup disabled. `account-link` does all account-dependent work after its generic response; failures log only fixed codes. Its target RPC is service-only and returns no target for agents or mismatched/expired workspace tokens. `send-email` does not read delivery credentials from `private.app_secrets`; only the existing pg_net authentication secret remains there. Password verification happens on form submission, never mount, and an AAL2 requirement opens the authenticator-code step before the password update. `tests/clone/setPassword.test.ts`, `account-link/handler.test.ts`, `_shared/accountEmail.test.ts` and `supabase/tests/clone/06_account_access.sql` cover these boundaries. The OAuth session smoke adds its member with `invite_member`, subject to the same allowance.

After accepting a workspace invitation, bootstrap uses the server copy when local pages are untouched starter content and the workspace has live pages. Meaningful local content still merges. Only an unlinked workspace may offer the local/server conflict choice: an invitee must never replace the owner's pages with a local copy. Migration 0052 contains the account-access boundary.
