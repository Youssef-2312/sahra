# Phase 4 workstreams (parallel sessions)

The coordinating session (the one the owner talks to) splits Phase 4 into
workstreams. Each worker session builds ONE workstream on its own branch, from
the base commit named in its task. Only the coordinator integrates, opens pull
requests, and talks to the owner.

## Hard rules (from the owner's brief; never bend these)

1. A QR code used twice is the worst possible failure. When in doubt, fail closed.
2. Halloween-26 (its Vercel project, GitHub repo, Upstash database, Google Form
   and Apps Script) is never edited, redeployed, reconfigured or deleted.
3. Buy nothing. No paid plans.
4. No passwords stored anywhere, no password hashing. Never weaken a security
   measure to fit a free tier; if something does not fit, stop and report options.
5. No offline scanner mode. No Google Drive as a live database. Party owners'
   Gmail accounts and app passwords are never used.
6. No emojis in UI or emails.
7. Workers never act on the owner's accounts: no Cloudflare/Google/Vercel
   resources, no deploys, no secrets, no real email, nothing touching
   Halloween-26. No `wrangler` command with `--remote`. Never push to `main` or
   `staging`; push only your own branch.
8. Wording: "only one successful database redemption per ticket" (never "double
   entry is impossible"); "designed to stay within free allowances" (never "$0" or
   "free forever"); "reduces the risk", never a guarantee. Report measured numbers
   only, and say when something is only tested locally.
9. Never print, commit or ask for secrets. Tests use the fixed test-only values in
   `vitest.config.ts`.
10. Unauthenticated requests write nothing to D1, except guest sign-up (behind
    Turnstile) and door join with a valid invitation. Every new route gets a case
    in `test/unauth.test.ts` (the "covers every registered route" test enforces it).

Read `docs/DECISIONS.md` fully before starting: it holds every owner decision
(storage, quotas, CPU target, change log, Phase 4 choices, operating model).

## Conventions (follow the existing code)

- **Every rule that decides whether a change happens is inside the SQL statement
  that makes it**, including `sessionValid(...)` (src/db/index.ts). Multi-row
  changes are ONE `driver.batch([...])` (one transaction).
- **Every change to a logged entity** (party, staff, invite, ticket, and any new
  entity that matters for recovery) bumps `rev`, sets `last_op` (a fresh
  `newId()`) and `last_action`, writes an `audit(...)` row in the same batch, and
  is confirmed to the user only after `flushChangeLog(...)` succeeds (otherwise the
  route throws `LogPendingError`, answered 503 "pending, retry"). A new logged
  table needs `rev`, `logged_rev`, `last_op`, `last_action` and a line in
  `Db.unlogged()` / `markLogged()`.
- **Changes that would be unsafe to lose in a recovery** (ticket cancel, reissue,
  name transfer; staff role change or disable; anything that removes access or
  invalidates a code) call `recordIntent(...)` (src/changes.ts) with the same op id
  BEFORE the main batch.
- **Emails** are rows added with `outboxInsert(...)` (src/outbox.ts) inside the
  batch of the change that causes them. Nothing sends email yet. "Message all
  guests" rows use `needsApproval: true`.
- **Migrations are additive only** (CREATE TABLE, ADD COLUMN, CREATE INDEX). Never
  edit an applied migration. Tables `STRICT`; `WITHOUT ROWID` with a TEXT primary
  key where rows are written often. Only add a secondary index if a query needs it,
  and say what it costs in rows written.
- **Cost:** count rows read/written per request (the request log line shows them)
  and keep hot paths cheap; Workers Free allows 10 ms CPU per request, 50 queries
  per request, 100,000 rows written per day for the whole account. Dashboards poll
  every 30 to 60 s with a cheap "anything changed?" check.
- **Never touch the scan path** (src/routes/scan.ts, TicketDb.redeem, the ledger's
  admission record and control object, src/warmup.ts) or recovery (src/recovery/,
  src/changes.ts). If you need a change there, stop and report it.
- Pages are bare, unstyled test pages in `public/` (the real frontend comes later).
  Every page has the login/account at the top-left and a "Made by Nova" link at the
  top-right (placeholder href).
- Style: match the surrounding code (Hono via `hono/tiny`, `json(c, status, body)`,
  `readJson`, `requireAuth([...roles])`, comment density as in src/routes/*.ts).

## Ownership (to avoid conflicts)

| WS | Scope | Owns | Migration file |
|---|---|---|---|
| A | Party details, address modes and reveal, countdown/map data, edit history | `src/party/`, `src/routes/party.ts` | `migrations/0005_party_details.sql` |
| B | Organisers by invitation, party creation by organisers, platform admin endpoints, disabling a party | `src/platform/`, `src/routes/platform.ts`, organiser sign-in in `src/routes/auth.ts` | `migrations/0006_organisers.sql` |
| C | Guest sign-up (per-party questions, Turnstile, screenshot upload), capacity in the same statement, close at capacity, approval queue, release, cancel, reissue, name transfer, guest ticket page by signed link, resend link, export data | `src/guests/`, `src/routes/guests.ts`, `src/routes/tickets.ts`, `src/storage/` | `migrations/0007_guests.sql` |

Shared files you may edit minimally (the coordinator resolves conflicts):
`src/app.ts` (register your routes), `src/env.ts` (new vars/secrets),
`src/db/index.ts` (`unlogged()` / `markLogged()` lines only), `test/unauth.test.ts`
(cases), `test/helpers.ts` (new helpers), `vitest.config.ts` (test-only bindings),
`docs/DECISIONS.md` (append a section for your workstream). Do not add ledger
migrations; ask the coordinator.

## Definition of done

- `npx tsc --noEmit -p .` clean, `npx vitest run` all passing (workerd).
- Tests for every rule, including at least: zero writes without a session on
  every new route, the race cases (two requests at once), and the failure cases
  (ledger or database unreachable: nothing confirmed, retry completes).
- Your DECISIONS.md section: what you built, rows read/written per request
  (measured in tests), what local tests cannot prove, what the owner must do or
  decide.
- Commit on your branch with a clear message, push your branch, and end with a
  report: summary, files, migrations, measured numbers, open questions.
