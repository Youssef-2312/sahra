# Sahra setup (owner's steps)

Everything here is done by you, on your accounts, from your own computer. Nothing
in this repository creates Cloudflare or Google resources by itself. Secrets are
generated and piped into Cloudflare by the scripts (or typed by you); never into
chat, never into the repository. There is no R2: every store is a D1 database.

**On Windows, double-click `setup.bat`** in the repository folder: it shows a menu
of the steps below. Every step is safe to run again, production steps ask you to
type `PROD`, and temporary Cloudflare errors are retried (2, 4, 8, 16 s). The
equivalent commands are listed for other systems.

Order: **A. Before merging the first pull request**, **B. After the first deploy**,
**C. Checkpoint A** (staging only). Decisions behind these steps: `docs/DECISIONS.md`.

You need Node.js 20+ and git.

---

## A. Before merging the first pull request

### A1. Get the code and sign in to Cloudflare

```sh
git clone https://github.com/Youssef-2312/sahra && cd sahra
git checkout claude/eager-fermi-4hp8lg     # until the pull request is merged
npm ci
npx wrangler login                          # setup.bat step 1
```

`npm ci` runs two install scripts (workerd, esbuild); they are approved in
`package.json` (`allowScripts`), so npm 12 runs them without asking.

### A2. D1 databases (done)

All four exist and their ids are in `wrangler.jsonc`:

| # | Database | Purpose | Region |
|---|---|---|---|
| 1 | sahra-prod | tickets, staff, sessions, scans | EEUR |
| 2 | sahra-ledger-prod | change log, control objects, admission records | EEUR |
| 3 | sahra-staging | staging copy of 1 | EEUR |
| 4 | sahra-ledger-staging | staging copy of 2 | EEUR |
| 5 | sahra-files-1 | payment screenshots (Phase 4) | EEUR |
| 6-10 | free | more `sahra-files-N`, staging files, standby drill | EEUR |

Workers Free plan: at most 10 databases per account, 500 MB per database, 5 GB in
total. **Rule: every future database is created in the same region as the main
and ledger databases:** `npx wrangler d1 create <name> --location eeur`. Send Claude
the new id before using it, so `wrangler.jsonc` never holds a placeholder that a
command could pick up.

### A3. Apply the migrations (you run these; deploys never do)

setup.bat step 2 (staging), then step 3 (production), then step 4 (status). Or:

```sh
# staging first
npx wrangler d1 migrations apply DB --remote --env staging        # sahra-staging
npx wrangler d1 migrations apply LEDGER --remote --env staging    # sahra-ledger-staging
npx wrangler d1 execute DB --remote --env staging --file migrations-staging/main/0001_proto.sql
npx wrangler d1 execute LEDGER --remote --env staging --file migrations-staging/ledger/0001_proto.sql
# then production
npx wrangler d1 migrations apply DB --remote --env=""                      # sahra-prod
npx wrangler d1 migrations apply LEDGER --remote --env=""                  # sahra-ledger-prod
# check: each must say "No migrations to apply"
npx wrangler d1 migrations list DB --remote --env staging
npx wrangler d1 migrations list LEDGER --remote --env staging
npx wrangler d1 migrations list DB --remote --env=""
npx wrangler d1 migrations list LEDGER --remote --env=""
```

The two `migrations-staging` files are staging-only (the Checkpoint A prototype);
production never gets those tables.

**Rule for every later pull request.** A pull request that adds files under
`migrations/` or `migrations-ledger/` says so in the first line of its description.
Before you merge it:

1. Apply the new migrations to staging (setup.bat step 2), let staging deploy that
   branch, and test.
2. Apply them to production (step 3).
3. Check the status (step 4): all four databases must say nothing to apply.
4. Only then merge (merging to `main` deploys production).

Every migration is written so the code already live keeps working with it (only
additions). Never edit a migration file that has been applied.

### A4. Connect the repository to Workers Builds (two Workers)

Dashboard: **Workers & Pages > Create > Import a repository > Youssef-2312/sahra**,
twice:

| Setting | Production | Staging |
|---|---|---|
| Worker name | `sahra` | `sahra-staging` |
| Production branch | `main` | `staging` |
| Build command | (empty) | (empty) |
| Deploy command | `npx wrangler deploy --env=""` | `npx wrangler deploy --env staging` |
| Enable Preview Builds | **off** | **off** |
| API token | the one Workers Builds creates, unchanged | same |

**No D1 permission is needed.** With `database_id` set, `wrangler deploy` (4.124, the
version this repository pins) makes no D1 API calls: `isFullySpecified()` skips
resource provisioning when the id is present (checked in wrangler's source). The
bindings are attached by id when the script is uploaded, which "Workers Scripts:
Edit" covers. The first build confirms it; if it fails with a D1 authorization
error, send Claude the build log.

`--env=""` selects the top-level (production) configuration explicitly, which
also silences wrangler's "multiple environments" warning. The deploy command lives
in Cloudflare (Workers & Pages > sahra > Settings > Build > Deploy command), so
changing it there is a dashboard step, not something a pull request can do.

Claude pushes to `staging` (staging auto-deploys from it); `main` changes only
through pull requests you merge.

### A5. First deploy

When Claude says the pull request is final: do A3, then merge. Production deploys
from `main`; staging deploys from `staging`. Until the secrets in B2 exist, sign-in
answers "server not configured" (it fails closed).

---

## B. After the first deploy

### B1. Send Claude the two addresses

`https://sahra.<subdomain>.workers.dev` and `https://sahra-staging.<subdomain>.workers.dev`.

### B2. Secrets

setup.bat step 5 (staging) and step 6 (production). Each creates only the missing
ones of `COOKIE_MASTER_K1`, `QR_MASTER_K1`, `LINK_MASTER_K1`, with a fresh random
value per Worker, so staging and production never share a value. Existing secrets
are never replaced. Manual equivalent (one line per secret and Worker):

```sh
node scripts/gen-secret.mjs | npx wrangler secret put COOKIE_MASTER_K1 --env staging
```

### B3. Two Google OAuth clients (one per Worker)

Google Cloud Console > APIs & Services:

1. OAuth consent screen: User type **External**, app name "Sahra", scopes only
   `openid`, `email`, `profile`. **No logo**, no other branding. Publish (In production).
2. Credentials > Create credentials > OAuth client ID > **Web application**, twice:
   - "Sahra production", redirect URI exactly
     `https://sahra.<subdomain>.workers.dev/api/auth/google/callback`
   - "Sahra staging", redirect URI exactly
     `https://sahra-staging.<subdomain>.workers.dev/api/auth/google/callback`
3. Send Claude both **client IDs** (not secrets). Set each client's secret on its own
   Worker: setup.bat step 7 (staging client) and step 8 (production client), or
   `npx wrangler secret put GOOGLE_CLIENT_SECRET [--env staging]`.

Claude's next pull request sets the client IDs and addresses; merge it.

### B4. Create a party and its owner

setup.bat step 9 (asks for staging or production, refuses an id that exists).
For Checkpoint A, create one on staging (for example id `checkpoint-a`). The owner
then signs in with Google at that Worker's address (invitation valid 14 days).

---

## C. Checkpoint A (staging only)

The scan prototype is enabled only in staging, and the script refuses any host
other than `sahra-staging.`.

### C1. Sign-in with a Google key cache miss

1. Redeploy staging (Claude pushes a commit to `staging`, or Workers & Pages >
   sahra-staging > Deployments > latest build > Retry).
2. Within a minute, in a private window, sign in at the staging address. Sign out
   and sign in 3 more times.

### C2. Live concurrency tests and scan prototype

1. On the staging dashboard, "Invite door staff": name `checkpoint-a`, 1 hour.
2. setup.bat step 10 (paste the link), or:

```sh
node scripts/checkpoint-a.mjs --invite "<the link>" --scans 50 --phones 8
```

Checks, live: 8 simultaneous joins on one invitation give exactly one session; a
join retry with the same browser value succeeds; per ticket admit, same-ID retry
(stored outcome), second scan (used), forged code (stop); 8 simultaneous scans of
one ticket give exactly one admit (20 tickets). Prints PASS/FAIL and client
round-trip latency. Rows: about 50 x (4 + 6 + 3 + 0) + 20 x 8 x ~4 = roughly 1,300
rows written, about 1.3% of the daily limit.

3. Revoke the invitation on the dashboard afterwards.

### C3. CPU per endpoint, cold vs warm (setup.bat step 12)

Right after a staging deploy (new isolates), run step 12. It connects to the
staging request stream (`wrangler tail`), asks you to sign in on staging 3 times,
then asks for a new 1-hour door invitation link and runs the Checkpoint A traffic.
At the end it prints CPU p50/p95/p99/max per endpoint, separately for cold
requests (an isolate's first) and warm ones, and saves a summary file
`cpu-report-<time>.json` (no cookies, links or secrets). Target: warm p99 under
5 ms on every endpoint. Revoke the invitation afterwards.

Step 11 (read-only) compares admitted tickets with ledger admission records; run
it after any Checkpoint A run.

### C4. Read CPU time and rows in the dashboard (alternative)

**Workers & Pages > sahra-staging > Observability**, last hour, Query Builder:

- Calculate `P50`, `P95`, `max` of `$workers.cpuTimeMs` (and `$workers.wallTimeMs`).
- Filter `$workers.event.request.url` includes, in turn: `/api/auth/google/callback`,
  `/api/proto/scan`, `/api/invites/consume`, `/api/auth/google/start`.
- Cache miss: in the callback events, the log line `{"evt":"req",...,"jwks":"miss"}`
  marks requests that fetched Google's keys; note their `$workers.cpuTimeMs`.
- The same lines carry `rows_written` (sahra-staging) and `ledger_rows_written`
  (sahra-ledger-staging) from D1's own metadata.
- **Storage & databases > D1 > sahra-staging** and **sahra-ledger-staging > Metrics**
  for the day's rows; the Worker's **Metrics > Errors** for "Exceeded CPU Time Limits".

Send Claude the script output and those numbers. Never send cookies, secrets or the
invitation link.

---

## Accepted risks (details in docs/DECISIONS.md)

- **Request flooding** can exhaust the account's 100,000 Workers requests per day and
  stop the door. No free fix without a domain; Cloudflare's automatic DDoS
  protection still applies. The door is not protected from this.
- **sahra-ledger is not a backup**: it shares the account and its quotas. The Google
  Drive copy (Phase 4) is the only copy outside Cloudflare.
