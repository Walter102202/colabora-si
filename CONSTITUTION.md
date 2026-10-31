# Constitution

Twelve rules that always hold in this repository. Operating production is in [RUNBOOK.md](RUNBOOK.md); building and verifying a change is in [AGENTS.md](AGENTS.md).

1. **Main is always deployable.** A change reaches `main` only through a pull request whose `check` job is green. Nobody pushes to `main` directly and nobody merges red, the maintainer included. (GitHub: require the `check` status check in the `main` ruleset, and let the admin role bypass it only through a pull request, so every bypass shows on the pull request.)
2. **Only a person merges.** Agents push a branch and report what changed, how it was verified and what is blocked. A person opens the pull request, waits for `check` and merges.
3. **No secret in git.** Secrets live in the Supabase Edge Function secrets, the Vercel project settings and the ignored `.env*` files. Versioned files carry placeholders such as `<project-ref>`. A leaked secret is rotated, not deleted from history.
4. **One security boundary.** Row Level Security and `SECURITY DEFINER` RPCs with an empty `search_path` decide every read and write. Every RPC ships with a negative pgTAP test. No API routes, no middleware, no service role in the browser or in the `mcp` function.
5. **Migrations are append-only.** A migration that is on `main` is never edited or renumbered; the next change is a new numbered file, and `check` fails any other kind. Hosted Postgres applies each version once, so an edit to an old file never reaches production.
6. **The backend is deployed by hand from main.** `supabase db push` and `supabase functions deploy` run only from a clean checkout of `main`, after a data dump, in the order the runbook gives. `supabase config push` is never run against hosted. Nothing is deployed from a branch.
7. **The web app follows main on its own.** Vercel publishes every push to `main` without waiting for `check`. A change that adds a migration or an Edge Function is merged only when the person merging can deploy the backend right after.
8. **One owner per file.** The branch prefix `a/`, `b/` or `infra/` names the track, and `scripts/check-ownership.mjs` fails a change to another track's files. CI, configs and these documents are infra and belong to the maintainer.
9. **Generated files travel with their source.** `supabase/functions/_shared/cardHtml.ts` is rebuilt and the copies in `_shared/lib/` are recopied in the same change as their source; `check` fails when they drift.
10. **Only a person decides.** The server refuses approvals, closing a task, accepting a deliverable and revoking an agent to every agent, and no tool or prompt changes that. Merging this repository and deploying are done by a person with their own credentials.
11. **Published history stays.** No force-push, no history rewrite and no branch deletion on `main` or on another person's branch. (GitHub: the `main` ruleset already blocks force-pushes and deletion; keep it.)
12. **An emergency changes the speed, not the path.** A fix for broken production still goes through a pull request. The only exception, and what it requires, is written in [RUNBOOK.md](RUNBOOK.md#the-one-emergency-exception).
