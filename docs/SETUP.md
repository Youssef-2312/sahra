# Sahra setup (owner's steps)

Everything here is done by you, on your accounts, from your own computer. Nothing
in this repository creates Cloudflare or Google resources by itself. Secrets are
piped or typed by you directly into Cloudflare, never into chat and never into the
repository. There is no R2: every store is a D1 database.

Steps are in the order you do them:
**A. Before the first deploy**, **B. After the first deploy**, **C. Checkpoint A** (staging only).

You need Node.js 20+ and git.

---

## A. Before the first deploy

### A1. Get the code and sign in to Cloudflare

```sh
git clone https://github.com/Youssef-2312/sahra && cd sahra
npm ci
npx wrangler login     # this login is the credential only you hold (migrations, restores)
```

### A2. Create the D1 databases

```sh
npx wrangler d1 create sahra-prod
npx wrangler d1 create sahra-ledger-prod
npx wrangler d1 create sahra-staging
npx wrangler d1 create sahra-ledger-staging
```

Each prints a `database_id`. Send the four ids to Claude (they are not secrets);
Claude puts them in `wrangler.jsonc`.

D1 slots on the Workers Free plan (maximum 10 databases per account; 500 MB per
database; 5 GB in total across all of them):

| # | Database | Purpose | When |
|---|---|---|---|
| 1 | sahra-prod | tickets, staff, sessions, scans | now |
| 2 | sahra-ledger-prod | change log, control objects, admission records (survives a restore of sahra-prod) | now |
| 3 | sahra-staging | staging copy of 1 | now |
| 4 | sahra-ledger-staging | staging copy of 2 | now |
| 5 | sahra-files-1 | payment screenshots | Phase 4 |
| 6-10 | free | more `sahra-files-N` as screenshots grow, standby drill if needed | later |

### A3. Apply the migrations (you run these; deploys never do)

```sh
# staging first
npx wrangler d1 migrations apply DB --remote --env staging        # sahra-staging
npx wrangler d1 migrations apply LEDGER --remote --env staging    # sahra-ledger-staging
# then production
npx wrangler d1 migrations apply DB --remote                      # sahra-prod
npx wrangler d1 migrations apply LEDGER --remote                  # sahra-ledger-prod
```

Check that nothing is pending:

```sh
npx wrangler d1 migrations list DB --remote --env staging
npx wrangler d1 migrations list LEDGER --remote --env staging
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations list LEDGER --remote
```

**Rule for later pull requests.** A pull request that adds files under
`migrations/` or `migrations-ledger/` says so in the first line of its description,
with the commands. Before you merge it:

1. Apply the new migrations to staging (the two staging commands above), let
   staging deploy that branch, and test.
2. Apply them to production (the two production commands above).
3. Run the `migrations list` commands: all four must say there is nothing to apply.
4. Only then merge (merging to `main` deploys production).

Claude writes every migration so the code that is already live keeps working with
it (only additions; removing a column or table happens in a later pull request,
after no deployed code uses it). Never edit a migration file that has been applied.

### A4. Connect the repository to Workers Builds (two Workers)

Dashboard: **Workers & Pages > Create > Import a repository > Youssef-2312/sahra**.
Do this twice.

| Setting | Production | Staging |
|---|---|---|
| Worker name | `sahra` | `sahra-staging` |
| Production branch | `main` | `staging` |
| Build command | (empty) | (empty) |
| Deploy command | `npx wrangler deploy` | `npx wrangler deploy --env staging` |
| Enable Preview Builds | **off** | **off** |
| API token | the one Workers Builds creates, unchanged | same |

Do **not** add any D1 permission to the token. With `database_id` set in
`wrangler.jsonc`, `wrangler deploy` (4.148) makes no D1 API calls; Claude checked
this in its source (`isFullySpecified()` skips resource provisioning when the id is
present). The bindings are attached by id when the script is uploaded, which the
token's "Workers Scripts: Edit" permission covers. The first build confirms it; if
it fails with a D1 authorization error, send Claude the build log.

The `staging` branch is what staging deploys. Claude pushes to it only when you
say so, and only after the staging migrations are applied.

### A5. First deploy

Claude opens a pull request into `main`. Push the same commit to `staging` (or let
Claude do it), and merge the pull request. Both Workers deploy. Until the secrets
in B2 exist, sign-in answers "server not configured" (it fails closed).

---

## B. After the first deploy

### B1. Send Claude the two addresses

`https://sahra.<subdomain>.workers.dev` and `https://sahra-staging.<subdomain>.workers.dev`.
Claude sets `PUBLIC_ORIGIN` for each.

### B2. Secrets (both Workers)

```sh
node scripts/gen-secret.mjs | npx wrangler secret put COOKIE_MASTER_K1
node scripts/gen-secret.mjs | npx wrangler secret put QR_MASTER_K1
node scripts/gen-secret.mjs | npx wrangler secret put LINK_MASTER_K1
node scripts/gen-secret.mjs | npx wrangler secret put COOKIE_MASTER_K1 --env staging
node scripts/gen-secret.mjs | npx wrangler secret put QR_MASTER_K1 --env staging
node scripts/gen-secret.mjs | npx wrangler secret put LINK_MASTER_K1 --env staging
```

Each run generates a new random value; staging and production never share one.

### B3. Google OAuth client

Google Cloud Console > APIs & Services:

1. OAuth consent screen: User type **External**, app name "Sahra", scopes only
   `openid`, `email`, `profile`. **No logo**, no other branding. Publish (In production).
2. Credentials > Create credentials > OAuth client ID > **Web application**, with
   exactly these two authorized redirect URIs:
   - `https://sahra.<subdomain>.workers.dev/api/auth/google/callback`
   - `https://sahra-staging.<subdomain>.workers.dev/api/auth/google/callback`
3. Send Claude the **client ID** (not secret). Set the secret yourself:

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET                # paste when prompted (hidden)
npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
```

Claude's next pull request sets the client ID and addresses; merge it (and update
`staging`).

### B4. Create a party and its owner

Staging (for Checkpoint A):

```sh
node scripts/create-party.mjs --env staging --id checkpoint-a --name "Checkpoint A" \
  --capacity 300 --max-per-ticket 4 --owner-name "<you>" --owner-email <you>@gmail.com
```

Production, when you are ready for a real party: the same command without
`--env staging`, with the real details. The owner then signs in with Google at the
site (invitation valid 14 days).

---

## C. Checkpoint A (staging only)

The scan prototype is switched on only in staging (`ENABLE_PROTO` is "0" in
production). The script refuses to run against any host other than `sahra-staging.`.

### C1. Sign-in with a Google key cache miss

The Google key cache lives in each Worker isolate's memory; a new deployment starts
new isolates, so the first sign-in after a deploy fetches the keys.

1. Redeploy staging: Workers & Pages > sahra-staging > Deployments > the latest
   build > Retry (or let Claude push a commit to `staging`).
2. Within a minute, in a private window, sign in at
   `https://sahra-staging.<subdomain>.workers.dev/`. Sign out and sign in 3 more times.

### C2. Live concurrency tests and scan prototype

1. On the staging dashboard, "Invite door staff": name `checkpoint-a`, 1 hour. Copy the link.
2. Run:

```sh
node scripts/checkpoint-a.mjs --invite "<the link>" --scans 50 --phones 8
```

It checks, live: 8 simultaneous joins on one invitation give exactly one session;
a join retry with the same browser value succeeds; per ticket, admit / retry with
the same scan id returns the stored outcome / second scan says used / forged code
stops; and 8 simultaneous scans of one ticket give exactly one admit (20 tickets).
It prints PASS/FAIL per check and client round-trip latency.

3. Revoke the invitation on the dashboard afterwards (this ends the script's session).

### C3. Read CPU time and rows

Dashboard: **Workers & Pages > sahra-staging > Observability**, last hour, Query Builder:

- Calculate `P50`, `P95` and `max` of `$workers.cpuTimeMs` (and of `$workers.wallTimeMs`).
- Filter `$workers.event.request.url` includes, in turn:
  `/api/auth/google/callback`, `/api/proto/scan`, `/api/invites/consume`, `/api/auth/google/start`.
- For the cache miss: in the callback events, the custom log line
  `{"evt":"req",...,"jwks":"miss"}` marks the requests that fetched Google's keys;
  note their `$workers.cpuTimeMs` separately.
- The same log lines carry `rows_written` (sahra-staging) and `ledger_rows_written`
  (sahra-ledger-staging), from D1's own metadata.
- Also: **Storage & databases > D1 > sahra-staging** and **sahra-ledger-staging >
  Metrics** for the day's rows written, and **Metrics > Errors** on the Worker for
  any "Exceeded CPU Time Limits".

Send Claude: the script output; callback CPU for each cache-miss event plus
P50/P95/max; P50/P95/max for scan, join and start; the D1 rows written totals.
Never send cookies, secrets or the invitation link.
