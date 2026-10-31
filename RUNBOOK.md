# Runbook

How to ship a change and operate https://colabora.si. The rules behind it are in [CONSTITUTION.md](CONSTITUTION.md). Commands run from a checkout of this repository; replace `<project-ref>` with the hosted Supabase project reference and keep every real value out of git. `npx supabase@2.122.0` is the CLI version CI pins; a native `supabase` of the same version works too.

## Where each piece runs

| Piece | Where | Deployed by |
|---|---|---|
| Web app (`index.html`, `app/`, `api/pub.ts`) | Vercel, project connected to this repository | Vercel, on every push to `main`, without waiting for CI |
| Postgres, Auth, Storage, Realtime, Edge Functions (`supabase/`) | Hosted Supabase project `<project-ref>` | By hand, from a clean checkout of `main` (below) |
| Edge Function secrets | Supabase project settings | `supabase secrets set`, never a file in git |
| Scheduled ticks (dispatch, reminders, channel notices) | pg_cron inside the hosted database | The migrations, plus the Vault secrets set once by hand |
| Trama (`agent/fleet.mjs`) and the reviewer (`agent/`) | A host the maintainer runs | The maintainer, outside this repository |
| CI job `check` | GitHub Actions, `.github/workflows/ci.yml` | Every push and pull request |

The `deploy-backend` job in CI has no secrets and skips its steps: it deploys nothing.

## Ship a change

1. Branch from `main` with the owner prefix (`a/`, `b/`, `infra/`), commit with a scope, push with `git push -u origin <branch>`.
2. Agents stop here and report. A person opens the pull request and waits for `check` (about 4 minutes when green).
3. Merge only when `check` is green. Vercel publishes the web app within minutes.
4. If the change touched `supabase/migrations/` or `supabase/functions/`, deploy the backend now: until then the web app is ahead of its backend.

## Deploy the backend

```bash
git switch main && git pull --ff-only origin main && git status --porcelain
```

The last command must print nothing. Then, in this order:

```bash
npx supabase@2.122.0 link --project-ref <project-ref>
```

```bash
mkdir -p ~/colabora-backups && npx supabase@2.122.0 db dump --linked --data-only -f ~/colabora-backups/$(date +%F-%H%M)-data.sql
```

```bash
npx supabase@2.122.0 db push --linked
```

```bash
npx supabase@2.122.0 functions deploy --project-ref <project-ref>
```

Never run `supabase config push` against hosted: it uploads the local defaults in `supabase/config.toml` and overwrites the hosted Auth settings. Keep dumps outside the checkout. A new secret is set before the function that reads it is deployed:

```bash
npx supabase@2.122.0 secrets set --project-ref <project-ref> NAME=<value>
```

## Check production

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://colabora.si/
```

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<project-ref>.supabase.co/functions/v1/mcp
```

```bash
curl -sS https://<project-ref>.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource
```

```bash
npx supabase@2.122.0 migration list --linked
```

Expected: `200`, `401` (a `503` means the function does not boot), a JSON body naming the Auth issuer, and local and remote migration columns that match. Then sign in, open a page, and ask a connected agent to list its tasks. Logs are in the Supabase dashboard under Logs (Edge Functions, Postgres, Auth) and in Vercel under the deployment.

## Roll back

- **Web app.** Vercel → Deployments → the previous production deployment → Promote to Production. Then revert the commit on `main` through a pull request, or the next push republishes the bad version.
- **Edge Functions.** Deploy the last good commit, then return to `main`:

```bash
git switch --detach <good-sha> && npx supabase@2.122.0 functions deploy --project-ref <project-ref> && git switch main
```

- **Database schema.** Migrations only go forward. Write a new numbered migration that undoes the change, merge it through a pull request and deploy. Never edit or delete a migration that is on `main`.
- **Data.** Supabase dashboard → Database → Backups restores the whole database to a daily backup. For a few tables, load the dump taken before the push into a local stack and copy the rows back by hand.
- **A merge.** `git revert -m 1 <merge-sha>` on a branch, pull request, merge, deploy if the backend changed.

## When something breaks

1. Run the four checks above. They tell you whether the web app, the functions or the database is the broken piece.
2. Broken right after a merge, backend not yet deployed: finish the deploy. If you cannot, promote the previous Vercel deployment.
3. Broken right after a deploy: roll back the piece that changed (above), then fix forward through a pull request.
4. `check` red on `main`: `main` is not deployable. Revert the merge or fix forward; do not deploy until it is green.
5. A secret leaked: rotate it where it lives (Supabase secrets, Vercel settings, GitHub), then redeploy. Rotating `AGENT_LOGIN_PEPPER` breaks every agent login until each one is rotated from Settings → Agents.
6. An agent misbehaves: pause it, or all agents, from Settings → Agents, then revoke its tokens. Every run keeps its activity log and can be reverted from the task panel.
7. Write what happened and what fixed it in the pull request that closes the incident.

## The one emergency exception

Production is broken and `check` cannot run because GitHub Actions or the image registry is down. Then, and only then, the maintainer merges the pull request with the ruleset bypass, which GitHub records on the pull request, after running these locally on the branch:

```bash
npm run lint && npx tsc --noEmit && TZ=UTC npm test && npm run build
```

The pull request says why the bypass was used. `check` runs on `main` as soon as it can; if it is red, the merge is reverted the same day. Everything else, including a hotfix at night, waits the four minutes.
