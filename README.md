# colabora.si

A shared workspace for people and AI agents.

colabora.si is a local-first, Notion-style workspace where humans and AI agents work on the same pages: a block editor, pages in a tree, inline databases with views, comments, and an optional cloud for accounts, real-time sync, sharing and publishing. Agents are first-class authors: they connect through a remote [MCP](https://modelcontextprotocol.io) server, pick up tasks from an inline database, write into pages with visible attribution, ask for decisions, and hand work back for review. Any agent harness that speaks MCP can take part, and a task can pass from one harness to another without losing its brief, its permissions or its history.

## What it does

- **Editor.** Blocks (text, headings, lists, to-dos, toggles, quotes, callouts, code, dividers, media, embeds, tables, equations, columns, synced blocks), slash menu, Markdown shortcuts, inline formatting, drag and drop, smart paste.
- **Pages.** Tree with favorites and trash, icons and covers, backlinks, templates, version history, reminders, Markdown import and export.
- **Databases.** Table, board, list, gallery, calendar and timeline views; formulas, relations, rollups, filters, sorts, grouping, row templates.
- **Agents.** An "Agent Tasks" database as the control room: briefs written in the page, a Lead/Worker protocol, per-block attribution, decision and approval cards, undo of an agent's changes, cost per run. A remote MCP endpoint with read and write tools, plus connection recipes for the common harnesses.
- **Cloud (optional).** Accounts, sync by block operations (no lost edits, conflicts shown on the block), presence, sharing, public pages, file uploads, web push.

Without a backend the app is 100 % local: everything lives in the browser.

## Getting started

```bash
npm ci
npm run dev        # http://localhost:3000
```

Optional backend (Supabase):

```bash
cp .env.example .env.local   # fill in NEXT_PUBLIC_SUPABASE_URL and the publishable key
npx supabase start           # local Postgres, Auth, Realtime, Storage, Edge Functions
npx supabase db reset        # apply migrations and seeds
```

Checks:

```bash
npm run lint
npm test                      # Vitest
npx supabase test db          # pgTAP
npm run build
```

## Architecture

```text
app/            Next.js App Router routes (client components only)
components/     UI; components/agents/ holds the agent-layer surfaces
lib/            domain types, store, pure engines (markdown, formulas, sync operations)
supabase/       migrations, Edge Functions (mcp, agent-*, send-*), pgTAP tests, seeds
agent/          reference agent that works through the MCP endpoint
bridge/         stdio MCP bridge for local harnesses
connect/        connection recipes per harness
tests/          unit tests
```

Notes: the workspace is persisted under the `colabora-workspace` key in `localStorage`; every piece of rich HTML is sanitized before it is stored; page content reaches the server only as block operations applied in order by the database, so two writers never overwrite each other silently. See `AGENTS.md` for how the repository is organized and built.

## License

MIT
