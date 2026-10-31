# AGENTS.md

Guide for coding agents working in this repository. Read it before changing anything.

## What this is

colabora.si is a shared workspace where people and AI agents work on the same pages. It is a local-first, Notion-style app (block editor, page tree, inline databases with views, comments) with an optional Supabase backend for accounts, sync, sharing and publishing. Agents join through a remote MCP server: they take tasks from an "Agent Tasks" database, write into pages with visible attribution, ask people for input or approval, and hand deliverables back for review. Any MCP harness can take part (Claude Code, Codex, Cursor, Gemini CLI, Muse Code, chat apps, or the reference agent in `agent/`), and a task can pass from one harness to another because its brief, permissions and history live in the workspace.

## Stack and folders

- Web app: Vite 7, React 19, React Router 7 (single-page app, `index.html` loads `app/main.tsx`), Zustand, Tailwind 4, TypeScript strict. `vercel.json` rewrites every path to `index.html`.
- Backend: Supabase. Postgres 17 migrations and seeds under `supabase/`, Edge Functions in Deno under `supabase/functions/`, SQL tests in pgTAP.
- Node tooling: `bridge/` (stdio MCP bridge plus the Claude Code channel), `agent/` (reference agent), `connect/` (one recipe per harness). Node 22, no dependencies beyond the root `node_modules`.

```text
app/                 SPA routes; app/main.tsx is the entry
apps/card.html       second Vite entry: the MCP App card
components/          UI; components/agents/ is the agent layer, components/agents/panel/ its pure views
lib/                 types, stores, pure engines; lib/agent* is the client side of the agent layer
supabase/migrations  0001 core, 0002 agents, 0003 core RPCs, 0004 tasks, 0005 partial writes, 0006 control, 0007 derived state, 0008 dispatch, 0009 lead, 0010 retention,
                     0011 chat decisions, 0012 receipts for actions, 0013 agent write boundary, 0014 task.updated events, 0015 search, 0016 page ops review and version cap,
                     0017 platform agent, 0018 reviewer agent, 0019 handover, 0020 decisions, 0021 metrics, 0022 blocked review and webhook delivery, 0023 fair push batches,
                     0024 claim dependencies, 0025 AI properties, 0026 AI rewrite, 0027 mention tasks, 0028 file texts, 0029 OAuth session links, 0030 CI evidence,
                     0031 run lease, 0032 task environment, 0033 finding severity, 0034 reviewer policy, 0035 conditional approval
supabase/functions   mcp, agent-token, agent-admin, agent-dispatch, agent-webhook, github-webhook, pub-html, send-reminders, send-email; _shared/ holds the MCP server and its tools
supabase/tests       pgTAP suites (clone/, agents/)
supabase/seeds       demo workspace (01) and demo agents (02)
tests/               Vitest suites (clone/, agents/, infra/)
scripts/             repository checks (ownership)
```

## Two tracks, one owner per file

Track A is the agent layer, track B is the workspace product, infra belongs to the maintainer. `OWNERS.json` maps path patterns to an owner (longest match wins); `scripts/check-ownership.mjs` enforces it and CI runs it on every push. Branch names carry the owner: `a/<topic>`, `b/<topic>`, `infra/<topic>`.

```bash
node scripts/check-ownership.mjs --owner A --base origin/main   # or --owner B, --owner infra
node scripts/check-ownership.mjs                                 # owner inferred from the branch prefix
```

If you need a change in another track's files (an npm script, a config flag, a prop), do not make it: describe it in your report and continue with what does not depend on it.

## Run and verify

```bash
npm ci                                   # reproducible install, lockfile is the source of truth
npm run dev                              # http://127.0.0.1:3000
npm run lint                             # ESLint, zero warnings
npx tsc --noEmit                         # types
TZ=UTC npx vitest run                    # all Vitest suites (tests/clone, tests/agents)
npx vitest run tests/agents/bridge.test.ts -t "<name>"   # one suite or one test
npm run build                            # tsc plus vite build, must be clean
cd supabase/functions && deno task test  # Deno tests of the Edge Functions
npx supabase start                       # local stack (Docker): Postgres 17, Auth, Realtime, Storage, Functions
npx supabase db reset                    # apply migrations and seeds
npx supabase test db                     # pgTAP suites under supabase/tests/
npx supabase functions serve --env-file supabase/functions/.env   # Edge Functions against the local stack
```

A task is done when its suites pass, lint, types and build are clean, and the ownership check passes.

## Conventions

- English everywhere: code, comments, docs, commit messages. Conventional commits with a scope: `feat(editor): …`, `fix(agents): …`, `chore(agents): …`, `infra(docs): …`. One commit per finished task; never skip hooks.
- LF line endings (`.gitattributes` enforces them). Two spaces, double quotes, semicolons, `@/` import alias.
- No new dependencies unless the report states why. Markdown, LaTeX, code highlighting, emoji, ZIP, sanitization and Web Push are written in-house. `package.json` is infra.
- Accessibility: native controls (`button`, `input`, `select`, `dialog`) with visible labels or `aria-label`; `jsx-a11y` strict runs on `app/`, `components/` and `lib/`.
- State is reachable by URL: pages at `/p/<id>`, a task as `?task=<id>`, settings tabs, search and peeks as query parameters. Build links with `lib/routes.ts`, never by hand.
- `components/agents/panel/` holds pure views: data and callbacks in, no router, stores or network. The workspace mounts them through `RowPanel`; the MCP App card mounts them in an isolated React root.
- Every workspace mutation goes through a store action and produces new objects. Rich HTML passes `sanitizeHtml()` before storage; every user-provided URL passes `safeHref()` or `toEmbedSrc()` before rendering.
- Page content reaches the server only as block operations applied by the `apply_page_ops` RPC. The security boundary is Row Level Security plus `SECURITY DEFINER` RPCs, each with a negative pgTAP test.
- Tests first: Vitest in `tests/<track>/` (add `// @vitest-environment happy-dom` when the DOM is needed), Deno tests next to each function, pgTAP in `supabase/tests/<track>/`.

## Contracts

| Contract | Where |
|---|---|
| Deep links: `/p/<id>?task=…`, `/shared/<id>`, `/pub/<id>`, settings, search, peek | `lib/routes.ts` |
| Pure agent views and their props | `components/agents/panel/index.ts` |
| MCP tools (read, write, tasks, lead, wait), prompts and resources | `supabase/functions/_shared/tools/*.ts` |
| MCP server (JSON-RPC, auth, sessions) | `supabase/functions/_shared/mcp.ts`, served by `supabase/functions/mcp/` |
| SQL RPCs and policies | `supabase/migrations/`, one numbered migration per concern |
| Track B mounts from track A | `AttributionMargin`, `AgentPropertyCell`, `RowPanel`, `PresenceBadge`, `InboxBell`, `DecisionsHome`, `AgentsSettingsTab`, `McpPatPage`, `AGENT_TASKS_TEMPLATE`, `runAgentAction` |
| Track A imports from track B | `lib/types.ts`, store selectors, `lib/blockOps.ts`, `lib/dbOps.ts`, `lib/pageOps.ts`, `lib/routes.ts`, the `apply_page_ops` RPC |

Props, tool schemas and RPC signatures are contracts: agree a change with the other track before making it.

### Development loop contracts (P11)

| Migration | Contract |
|---|---|
| 0031 | A silent run loses its lease; human waits and stops in progress are preserved. |
| 0032 | `agent_resources`; exclusive environment reservations and confirmed release. |
| 0033 | Blocking/minor findings; minor notes never satisfy acceptance criteria. |
| 0034 | Parent reviewer policy opens a separate review task for each delivery. |
| 0035 | Trusted conditional approval, checked against the current delivery and brief at request and act. |

| Tools / prompt | Purpose |
|---|---|
| `import_plan`, `update_subtask` | Import dependencies, correct a versioned brief or reassign a subtask. |
| `reserve_environment`, `list_environments`, `release_environment` | Reserve and inspect resources; confirm shutdown before releasing them. |
| `create_task`, `submit_for_review`, `review_delivery` | Set `reviewer` / `lease_minutes`; hand delivery to the reviewer and use its own review-task run. |
| `wait_for_my_tasks` | Returns the latest own run's `session_id`; the Codex watcher never guesses a destination. |

`node tests/agents/loop-e2e.mjs` needs a seeded, served local stack and `.env.local` with its URL/public key. It exercises the whole loop using the four local seed agents and seed owner, including synthetic CI evidence, without performing outside actions. Never use a real-work Codex chat for watcher tests. Use the watcher or the hook, not both.

## Environment variables

| Prefix | Who reads it | Documented in |
|---|---|---|
| `VITE_*` | the web app bundle: Supabase URL and publishable key, app URL, MCP URL, VAPID public key | `.env.example` |
| `WORKSPACE_*` | `bridge/`, `agent/` and the `connect/` recipes: MCP URL, agent PAT, token URL, Supabase URL and key, app URL | `bridge/README.md`, `agent/.env.example` |
| Edge Function secrets | `supabase/functions/*`: login pepper, allowed origins, resource and auth server URLs, app URL, dispatch secret | `supabase/functions/.env.example` |

`VITE_*` values ship in the browser bundle, so nothing secret goes in them.

## Do not

- Commit secrets or `.env*` files; the `.env.example` files are the only versioned ones. Nothing under `.local/` is versioned.
- Deploy from a branch. `main` is the only source of a deployment; CI pushes migrations and functions from it.
- Open pull requests or merge. Push the branch and report what changed, how it was verified and what is blocked.
- Edit another track's files, `package.json` or the root configs from a track branch.
- Delete branches, rewrite published history or force-push.
