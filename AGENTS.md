# AGENTS.md

Guide for coding agents working in this repository. Read it fully before changing anything.

## What this is

colabora.si is a local-first workspace where people and AI agents work on the same pages: a block editor, pages in a tree, inline databases, comments, and an optional cloud (Supabase) for accounts, sync, sharing and publishing. Agents connect through a remote MCP server and show up in the workspace as first-class authors.

## Two tracks, one owner per file

The repository is built by two tracks in parallel. **No file has two owners.** `OWNERS.json` maps path prefixes to an owner:

- **A** (agent layer): `components/agents/`, `lib/agent*`, `agent/`, `connect/`, `bridge/`, `supabase/migrations/*_0002_*` and `*_0004_*`…`*_0010_*`, `supabase/functions/` except `send-reminders/` and `send-email/`, `supabase/seeds/02_agents.sql`, `supabase/tests/agents/`, `tests/agents/`.
- **B** (workspace product): `app/`, `components/` except `components/agents/`, `lib/` except `lib/agent*`, `supabase/migrations/*_0001_*` and `*_0003_*`, `supabase/functions/send-reminders/` and `send-email/`, `supabase/seeds/01_workspace.sql`, `supabase/tests/clone/`, `tests/clone/`, `public/`.
- **Infra** (maintainer only): `.github/`, `package.json`, `tsconfig*`, `next.config.*`, `eslint.config.*`, `postcss.config.*`, `vitest.config.*`, `supabase/config.toml`, `OWNERS.json`, `AGENTS.md`, `scripts/`, `docs/`, `README.md`.

Branch names carry the owner: `a/<topic>`, `b/<topic>`, `infra/<topic>`. Before **every** commit run:

```bash
node scripts/check-ownership.mjs
```

It fails if a file outside your track changed. CI runs the same check on every push. If you need a change in another track's files (a new npm script, a config flag, a plug prop), do not make it: describe it in your report and continue with what does not depend on it.

## Contact points between tracks

Track B mounts eight components/functions owned by track A and never edits them: `AttributionMargin`, `AgentPropertyCell`, `RowPanel`, `PresenceBadge`, `InboxBell`, `AgentsSettingsTab` (all in `components/agents/`), `AGENT_TASKS_TEMPLATE` (`lib/agentTasksTemplate.ts`) and `runAgentAction` (`lib/agentActions.ts`). Their props are frozen; changing a prop is a contract change that must be agreed first.

Track A imports from track B only its public API: `lib/types.ts`, the store selectors, `BlockOps` (`lib/blockOps.ts`), `DbOps` (`lib/dbOps.ts`), `lib/pageOps.ts` (`PageOp`, `applyOps`, `diffPageToOps`) and the SQL function `apply_page_ops`. In SQL, migration 0001 declares `private.agent_can_read` / `private.agent_can_write` as stubs and 0002 replaces them; nothing else crosses.

## Commands

```bash
npm ci                    # reproducible install (lockfile is the source of truth)
npm run dev               # http://localhost:3000
npm run lint              # ESLint, must be clean (no warnings)
npm test                  # Vitest, all suites once
npx vitest run tests/clone/<file>.test.ts -t "<name>"   # one suite / one test
npm run build             # production build, must be clean
npx supabase start        # local Postgres 17 + Auth + Realtime + Storage (Docker)
npx supabase db reset     # apply migrations and seeds
npx supabase test db      # pgTAP suites under supabase/tests/
```

## Conventions

- TypeScript strict, two spaces, double quotes, semicolons, `@/` alias. Components and types in `PascalCase`, functions and variables in `camelCase`, hooks prefixed `use`, tests as `tests/<track>/<module>.test.ts`.
- The app is 100 % client-side: every page under `app/` and every interactive component starts with `"use client"`. No `app/api/`, no `middleware.ts`, no `@supabase/ssr`, no server data fetching, no `unstable_instant` or other segment config.
- Every workspace mutation goes through an action in `lib/store.ts` and produces new objects (undo/redo snapshots by reference). Every mutation updates `updatedAt`.
- Rich HTML is sanitized with `sanitizeHtml()` before it is stored; every user-provided `href`, `src` or `url` goes through `safeHref()` / `toEmbedSrc()` before rendering.
- Page content reaches the server only as block operations applied by the `apply_page_ops` RPC. Never `update pages set data` directly; the database rejects it.
- No new dependencies. Markdown, LaTeX, code highlighting, emoji data, ZIP, sanitization and Web Push are written in-house. `package.json` is maintained by the maintainer.
- UI copy is English. Storage keys and names start with `colabora-`.
- Security boundary is Row Level Security plus each `SECURITY DEFINER` RPC with its negative test. No secret ever reaches the browser bundle (`NEXT_PUBLIC_*` only).

## Tests

Every behavior has a test before the code: unit suites in `tests/<track>/` (Vitest; `// @vitest-environment happy-dom` per file when the DOM is needed), SQL suites in `supabase/tests/<track>/` (pgTAP). A task is done when its suites pass, `npm run lint` and `npm run build` are clean, and the ownership check passes.

## Commits and reports

Imperative, scoped commit messages: `feat(editor): preserve caret on split`, `fix(sync): …`, `test(db): …`. One commit per finished task; never skip hooks. Do not open pull requests or merge: push the branch and report what changed, how it was verified and what is blocked. Screenshots for UI changes go in `docs/images/` (maintainer adds them).
