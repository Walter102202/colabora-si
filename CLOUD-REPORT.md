# Cloud report: from a fresh clone to a person and an agent on one task

Session on a clean Linux VM (Node 22.23, Docker 29.9, no Deno, no model key), 2026-10-31. Only the repository's documentation was followed; code was read only after a documented step had failed.

## 1. Verdict

An outsider gets the local app, the Supabase stack and a signed-in demo owner from the README alone, but the first MCP call of any agent fails on the local stack until `MCP_AUTH_SERVER_URL` is set, a variable the README's backend steps did not mention (fixed in this branch). With that line, the whole loop (brief, claim, attributed writes, question, answer in the app, delivery, accept and close) ran in about 30 minutes including environment work; the documented path itself took about 20 minutes of that.

## 2. Path

| Step | What the docs said | What happened | Fix |
|---|---|---|---|
| 1. Local app | `npm ci`, `npm run dev` at http://127.0.0.1:3000 | Both worked. Headless Chromium (Playwright, installed outside the repository) loaded Home, created a page with "New page", typed a title and a paragraph; both survived a reload and the page appeared in the sidebar. No console errors. | none needed |
| 2. Backend | `npx supabase start`, `cp .env.example .env.local` + two values, `npx supabase db reset`, `cp supabase/functions/.env.example supabase/functions/.env` + pepper, `npx supabase functions serve --env-file …` | `npx supabase start` resolved CLI 2.122.0 (the version CI pins) and started Postgres 17.11, Auth, Realtime, Storage, Edge Runtime; all 35 migrations and both seeds applied. `npx supabase status` printed the URL and publishable key. `db reset` passed. `functions serve` started, but the first function call failed to boot for environment reasons (see §5), and after that every MCP call answered `invalid_token: The token was issued by another server.` because the local runtime sees `SUPABASE_URL=http://kong:8000` while Auth signs `http://127.0.0.1:54321/auth/v1`. Setting `MCP_AUTH_SERVER_URL` fixed it. | cfcfd4e |
| 3. Person | restart `npm run dev`, sign in as `owner@demo.local` with the password from `supabase/seeds/01_workspace.sql` | Signed in through the sidebar "Log in" button. Home showed "Synced", Decisions ("Ready for your review (1)") and the seeded pages. The Agent Tasks database is seeded under the title "Market research" (🤖) with the template's properties (Task, Lead, Worker, Status, Waiting on, Done when, …), four views and three rows. | none needed |
| 4. Agent | `cp agent/.env.example agent/.env`, `node agent/index.mjs --env agent/.env` | Used the seeded reviewer token with the local pepper, `WORKSPACE_MCP_URL=http://127.0.0.1:54321/functions/v1/mcp` and a scripted OpenAI-compatible endpoint written outside the repository on top of `agent/test/stub-model.mjs` (no model key available). The agent started, exchanged the token and waited on `wait_for_my_tasks`. | none needed |
| 5. Full task | "How a task flows" | In the app: "New from template" → "Task brief", title "Choose a venue for the team offsite", Goal and two "Done when" criteria written in the row page, "Hand this row to an agent" → Colabora Reviewer → "Save and assign" (Status: Queued, Brief v1, criteria c1, c2 listed under Verification). The agent claimed within seconds, read the page, appended a Findings section (5 blocks), asked a question with `request_input` (Status: "Needs your decision", card "Question: …", Changes card listing each added block, run waiting). The owner answered with "Reply" in the card; the task returned to "Working" in the same run (timeline #7 "You prompt · feedback"). The agent appended a Recommendation section, declared a page artifact covering c1, c2 and delivered (Status: "Ready for review", Deliverable v1 · page · covers c1, c2). Every agent block carried the attribution dot "Edited by Colabora Reviewer" with title "Colabora Reviewer · run acd70a89 (completed)"; the person's own blocks had none. Timeline #1–#11 matched the `agent_activities` rows (prompt, claim action, checkpoint, thought, append action, elicitation, prompt, checkpoint, append action, action, response). "Accept and close" + note → Status "Done accepted", row cell "Done accepted", timeline #12 "closed as accepted", `agent_tasks.state=done, acceptance=accepted`. | none needed |
| 6. Checks | six commands in "Checks" plus `tests/agents/mcp-smoke.mjs` | See §6. The smoke script failed on `append_blocks` with `run_not_active` before it had claimed a task. | 2fa7173 |
| 7. Docs | audit of README, AGENTS, CLAUDE, agent/bridge/connect READMEs, llms.txt | Two known defects confirmed and fixed (0e81b7e, b4155cd); two more false or incomplete claims fixed (055ba13, cbe417c). The rest is in §3. | see commits |

## 3. Found, not fixed

- `supabase/tests/clone/05_push_batches.sql:76` counts `public.pending_push_notifications()` over the whole database and expects 3. After one real task on the stack (two unpushed `input_required`/`ready_for_review` notifications for the owner, under 24 hours old) `npx supabase test db` reports "Failed test 10" in that file; after `npx supabase db reset` the same command passes (1315 tests). The test needs to scope its count to its own workspace or users; it is track B.
- `agent/README.md:29-42` settings table omits three variables that `agent/config.mjs` reads: `AGENT_RESUME` (`0` disables checkpoint resume), `WORKSPACE_MODEL_VISION` and `WORKSPACE_MODEL_PDF` (present in `agent/.env.example`, not in the table).
- `AGENTS.md:113` lists the Edge Function secrets as pepper, origins, URLs, app URL and dispatch secret; `supabase/functions/.env.example` also carries `CI_WEBHOOK_PEPPER`, which `github-webhook` and the CI connection depend on.
- `README.md:143` runs `npx supabase start` without a CLI version; `.github/workflows/ci.yml:61` pins 2.122.0. Today npx resolves the same version; the README gives an outsider no way to know which version the stack was tested with.
- `supabase/seeds/01_workspace.sql:22` titles the seeded Agent Tasks database "Market research". README and AGENTS.md speak only of an "Agent Tasks" database; an outsider looks for that name in the sidebar and finds it only by the 🤖 icon and the properties.
- `supabase/functions/send-email/index.ts:1` imports `jsr:@supabase/supabase-js@2` while every other function imports `@supabase/supabase-js` through `deno.json` (npm, pinned 2.112.3); the runtime loads two copies of the client from two registries.
- `supabase/functions/.env.example` and the README backend steps do not set `APP_URL`, so links in tool results and agent notifications are relative on a local stack (the reference agent prints its own `WORKSPACE_APP_URL`-based links instead).
- `components/agents/panel/RowPanelView.tsx:125` ("The title becomes the objective and the “Done when” cell the acceptance criteria") describes the fallback; with the "Task brief" template, `briefFromRow` (`lib/agentActions.ts:201`) uses the Goal and Done when sections, which is what happened here.

## 4. Decisions taken

- Used the seeded "Colabora Reviewer" token for the agent: of the four seeded agents it is the only enabled worker with no seeded tasks, so the scripted model could not pick up a demo task by mistake. The reference agent reports itself as `reference-agent`, which the app showed as the harness.
- Wrote the model stub as a conversation-driven server (it reads the task context and the previous tool results to choose the next tool call) rather than a fixed script, because block ids, run ids and the artifact id are only known at run time.
- Drove the person's side through the app only (template, brief blocks, assign, reply, accept and close); Postgres was read only to cross-check what the app showed.
- Fixed `tests/agents/mcp-smoke.mjs` by reordering (claim, then page steps, then delivery) instead of weakening its checks: the server's rule that an agent writes only inside a run is documented in README and llms.txt, so the script was stale, not the server.
- Did not pin the CLI or change `package.json`, `OWNERS.json`, migrations, tool schemas or props. Did not touch the push-batch test (track B, green in CI on a fresh database).
- Kept the stack running until the report was written, then stopped it with `npx supabase stop`.

## 5. Environment

- No systemd: `dockerd` had to be started by hand before `npx supabase start`.
- Outbound TLS is intercepted by the VM's egress proxy. `public.ecr.aws` pulls failed with "Data limit exceeded" and `docker.io` answered 429; the Supabase CLI fell back to `ghcr.io` on its own, so `npx supabase start` still completed.
- The Edge Runtime container trusts neither the proxy CA nor `DENO_CERT`, so its first worker could not fetch `npm:@supabase/supabase-js` (and later `@types/node`) and every function answered `BOOT_ERROR`. Workaround: Deno 2.9 (installed with `npm install -g deno`) cached the packages on the host (`deno install --entrypoint` over each function) and the `npm/` and `remote/` folders were copied into the `supabase_edge_runtime_colabora-si` volume. This is a VM constraint, not a product defect.
- Deno is not preinstalled; `npm install -g deno` gave 2.9.6, enough for `deno task test`.
- Playwright and Chromium are preinstalled under `/opt/node22/lib/node_modules`; a scratchpad `node_modules` symlink made `import { chromium } from "playwright"` resolve outside the repository.
- No model credentials: a local OpenAI-compatible stub served the agent.
- The hard file-descriptor limit made the CLI lower the Edge Runtime's limit to 20000 (a warning, no effect here).

## 6. Checks

| Command | Result |
|---|---|
| `node scripts/check-ownership.mjs` | exit 0: "no owner prefix on this branch (expected a/, b/ or infra/); nothing to check" |
| `npm run lint` | exit 0, zero warnings (also after the smoke-script change) |
| `TZ=UTC npm test` | exit 0: 95 files passed, 1 skipped; 1330 tests passed, 2 skipped |
| `cd supabase/functions && deno task test` | exit 0: 282 passed, 0 failed |
| `npx supabase test db` (after the real task flow) | exit 1: Files=51, Tests=1315, 1 failed (`clone/05_push_batches.sql` test 10, see §3) |
| `npx supabase test db` (after `npx supabase db reset`) | exit 0: Files=51, Tests=1315, Result: PASS |
| `npm run build` | exit 0: tsc clean, Vite built `index.html` and `apps/card.html` |
| `npx tsc --noEmit` (CI step) | exit 0 |
| `node tests/agents/mcp-smoke.mjs` (Codex seed token, `SMOKE_PAGE_ID=research-task-1`, `SMOKE_TASK_ID` = seeded task 51) | before 2fa7173: 4 ok, then `append_blocks failed: run_not_active`; after: 14 ok, "all checks passed" |
