# Decisions and requirements

Owner decisions that later phases must follow. Wording rules from the brief apply
("designed to stay within free allowances", "only one successful database
redemption per ticket", "reduces the risk", measured numbers only).

## Platform

- **No R2.** Every store is a D1 database: `sahra-prod` (main), `sahra-ledger-prod`
  (ledger), later `sahra-files-N` (screenshots); staging has its own copies.
- **One region.** All databases, main and ledger and files, production and staging,
  are created in the same location (today **EEUR**: `wrangler d1 create <name> --location eeur`).
- **Deploys** run only `wrangler deploy`. Migrations are applied by the owner from
  their own computer, staging first, before merging the pull request that needs
  them. Production migrations only ever add things. Staging-only tables live in
  `migrations-staging/` and never reach production.
- **Staging is required.** Live concurrency tests, the scan prototype and load tests
  run only on `sahra-staging`. Separate Google OAuth clients and separate secret
  values per Worker; production secrets are never reused in staging.

## Ledger (sahra-ledger)

- It protects against **controlled restores of the main database only**. It shares
  Cloudflare and the account-wide quotas, so it is **not an independent backup**.
  The Google Drive copy is the only copy outside Cloudflare.
- No transaction spans both databases. The main batch commits first; then ONE
  ledger batch writes the entry idempotently (entity + rev) and reads the control
  object. Green / confirmation only if that batch succeeds and the party is still
  open with the same `pause_number`; otherwise "recording" / pending, and a retry
  finishes it.
- Recovery restores only the main database, never the ledger.

## Sign-in and sessions

- No database write before a valid Google response (sealed attempt cookie).
- Callback writes only for an invited or active staff account. At most 10 sessions
  per staff member per rolling hour, checked read-only (counting session rows; no
  counter writes). The same cap applies to door joins.
- Party picker: sealed 2-minute Strict cookie, cleared on use; replay within those
  2 minutes only yields another session for the same verified person, subject to
  the cap.

## CPU (Workers Free: 10 ms per request)

- Target: **warm p99 under 5 ms on every endpoint**; cold requests (the first
  request in an isolate) are reported separately.
- Method: `setup.bat` step 12 (`scripts/measure-cpu.mjs`) streams staging's request
  events with `wrangler tail` (Cloudflare's CPU time per request) and splits them
  by our log field `iso_req` (1 = cold), per endpoint.
- Kept per isolate, not redone per request: imported Google keys (only the key a
  token names, imported once), derived per-party keys, the cookie encryption key.
  The CSRF token is a SHA-256 (no key import). Router: `hono/tiny` (no route-table
  compile on the first request). Bundle 105 KiB (27 KiB gzipped), was 122 KiB.
- **Startup warm-up** (CPU pass 2, `src/warmup.ts`). Live (n = 289 warm scans),
  a cold scan used 10-14 ms and a scan's first use in a warm isolate up to 9 ms;
  most of that is V8 compiling and first running our own code. The global scope
  has its own, larger startup limit, so the scan, join and session paths run once
  there against an in-memory stand-in for the databases (no real binding, a fixed
  dummy key; random values and body streams are not allowed at startup, so
  bodies are supplied directly and the parts after a random id are called
  directly). Its requests are not counted as cold/warm. Local profile
  (`node scripts/cpu-local.mjs`, Node's V8, SQLite time excluded): cold scan
  6.3 -> 2.2 ms, cold join 4.5 -> 1.7 ms, first scan in a warm isolate about
  3.6 -> 1.4 ms. Cloudflare's own binding code is not in those numbers; only a
  staging measurement shows the live effect.
- Each request's log line carries `in_flight` (requests running in the isolate
  at once); step 12 lists the slowest warm requests with it.
- **Measured on staging after pass 2, accepted by the owner** (498 requests,
  none over the CPU limit): warm scan p50 2 / p95 4 / p99 5 / max 5 ms (n = 308);
  warm join p99 4 ms (n = 144); cold scan max 6 ms (was 14), first scan in a warm
  isolate max 6 ms (was 9), cold join max 5 ms (was 8). Warm scan p99 is exactly
  5 ms (Cloudflare reports whole milliseconds); the slowest scans ran alone in
  their isolate (in_flight = 1) and early in its life (request 2 to 54), i.e. V8
  tiering up. The test cleanup endpoint now does at most 60 change-log rows per
  request (one request measured 10 ms for 63).

## Rate limits

- Scans: `RL_SCAN` is keyed per scanner session (never per IP; door phones on one
  Wi-Fi share an IP). Production 120 requests per 60 s per phone, about 2 per
  second sustained. A phone scanning one guest every 2 s with a retry on each
  scan uses about 60. If the limiter service itself errors, scans continue (the
  database still decides every admission); a missing binding blocks.
- Sign-in start, callback and door join: `RL_AUTH`, 20 per 60 s per IP (these
  happen once per person, not per guest).
- The limiter counts per Cloudflare location and is eventually consistent: abuse
  protection, not an exact counter.

## Accepted risks

- **Request flooding.** The Workers Free plan allows 100,000 requests per day for the
  whole account. Anyone can send requests to `/api/*` (static pages do not count);
  exhausting the allowance stops every Worker, including the door. There is no free
  fix without a domain we control (WAF rules need a zone). Cloudflare's automatic
  DDoS protection still applies. Requests without a session write nothing and read
  only a few rows, but **the door is not protected from this**.
- **Daily D1 quotas** (5M rows read, 100K rows written per day, whole account): past
  them, everything that writes fails, including the door. App-level limits (below)
  reduce the risk; they do not remove it.

## Quotas (from Phase 2 on)

- Conservative app-level limits on uploads, backups, exports, bulk email and polling.
- Stop non-essential work at about 50% of the daily limits.
- Describe these as "reduces the risk", never as a guarantee.

## Scanning (Phase 2, adopted)

- **Write sequence:** one main-database batch:
  1. a conditional ticket update that also requires that no scan row with this
     scan id exists, the party is open with the control object's pause_number, and
     the session is valid;
  2. the scan row inserted with its final outcome, computed from the ticket's
     state (ON CONFLICT DO NOTHING);
  3. a read back.

  Then ONE ledger batch: the admission record (`ticket:<id>:<rev>`, idempotent)
  plus a re-read of the control object.
- **Rows written (measured locally):** admit 2 main + 1 ledger (the prototype
  wrote 5 + 1); denial 1 + 0; a retry of a stored scan writes 0.
- **Tickets and scans** are `WITHOUT ROWID` with no secondary indexes on the scan
  path. `used_scan_id` has no unique index: a scan id maps to one ticket through
  `scans.scan_id` (primary key), and the ticket update requires that no scan row
  with that id exists yet.
- **Adopted** after all scanning tests passed and 9 deliberate breaks were each
  caught: dropping the "unused", "no scan row yet", "party open", "current QR
  version" or "released" rule from the update; green without a confirmed ledger
  write; skipping the control re-read; no session check in the update; ignoring a
  paused control object.
- **QR format:** `S1.<PARTY>.<K><TICKET>.<VERSION>.<SIG>`, Crockford base32, HMAC
  with a 130-bit truncated signature, per-party key from HKDF with a key id. Every
  code (up to 79 characters) is QR version 4 at level M in a single alphanumeric
  segment (33 x 33). Camera test: `docs/qr-camera-test/`.
- **QR readability (simulated, `scripts/qr-robustness.mjs`):** real-format codes
  rendered at phone size, degraded, and decoded by jsQR and ZXing. Read reliably:
  clean, dim screen (90/150 brightness), blur 1.5, rotation 25 degrees, camera at
  an angle, codes only 80 px wide. Error-correction level does not change the
  dim-screen results (L, M and Q behave alike), so level M stays. Very low contrast
  (110/150 and 125/150) fails as is but reads 10/10 after a per-frame contrast
  stretch; dim + camera noise reads 5/10 after averaging 4 frames plus stretch;
  everything combined at a small size still fails in software. Requirements for
  the frontend stage:
  - **Door scanner:** per-frame contrast stretch, average a few consecutive
    frames, and use the browser's native BarcodeDetector where available.
  - **Guest ticket page:** the QR large on a pure white background with a quiet
    zone, keep the screen awake while it is shown, a "turn brightness up" hint,
    and the saved image ("Save QR to photos") at full contrast.
  - A real two-phone check is still worth doing once at the frontend stage.
- **Admission control:** the control object lives in the ledger (`party_control`),
  changed only by a conditional write on its rev. Pause writes the control object
  first, then the main database; open writes the main database first, then the
  control object. Until both agree, scans answer "paused".
- **Staging-only test endpoints** (`/api/test/tickets`, `/api/test/door-invite`,
  `/api/test/ledger-check`, `/api/test/revoke-door-access`) answer 404 unless
  `ENABLE_TEST_TICKETS = "1"` (staging only); a test checks it. The last two let a
  cloud session, whose Cloudflare token has no D1 access, run the ledger check
  and the cleanup after a live run, for its own party only.
- **Measurement:** live runs report p50/p95/p99 only from at least 100 samples per
  endpoint (fewer is labelled "slowest seen"), with first use kept separate. The
  Google sign-in callback cannot be scripted (it needs real Google sign-ins and is
  capped at 10 per person per hour), so its numbers stay small-sample.
- Verify live that rows-written counts match local (step 12 prints rows per request).

## Recovery tests (before calling the two-database design proven)

- Main commits but the ledger write fails: no green; a retry completes it.
- Pause during an admission: no green.
- Lost responses and repeated retries.
- Cancellation, reissue and staff revocation after the backup point: none come back.
- Missing or incomplete ledger history: recovery stays blocked until an owner
  resolves each affected ticket.

## Screenshots (Phase 4)

- Compress in the browser (about 1600 px, JPEG, about 200 KB target); test that real
  InstaPay/Telda amounts and references stay readable.
- Binary BLOBs with parameterized writes, never base64. Server-enforced maximum size
  (D1 rows are limited to 2 MB).
- Stored in `sahra-files-N` behind the storage module; authenticated access only.
- Track actual database size; warn at 70% per database (500 MB each on Free) and at
  70% of the 5 GB account total. Capacity planning includes overhead, replacement
  screenshots and staging databases.

## Backup and restore (Phase 4)

- D1 SQL statements are limited to 100 KB: test whether a real export/import round
  trip keeps screenshot BLOBs byte-identical; if not, use a file-by-file
  parameterized restore.
- D1 exports block other requests to that database: main-database exports run only
  outside admission hours.
- Prove early: upload, read, back up to Drive, restore into a fresh database,
  identical bytes.

## Load test (replaces the 14,400-scan default)

On staging, on a day with no ticket sales:

1. 4,000 tickets, each admitted once within 30 minutes, across 10 parties x 4 scanners.
2. A 5-minute burst at 8 scans/s, including repeat scans and same-ID retries.

Estimate rows first and stop if it would pass 50% of the daily limit. Report p95
latency, errors, CPU and rows read/written (main + ledger).

## Operating model after handover (owner decision)

The owner builds the platform and then steps back: **organisers run their own
parties, and the owner only intervenes when something goes wrong.** Everything
must therefore run without the owner, fail closed, and tell the owner when it
needs them.

- **Organisers by invitation.** A platform admin invites organisers by email;
  each organiser can then create and run their own parties (owner role for those
  parties). Nobody else can create a party, so a stranger cannot set up a fake
  party under the site's name.
- **Small platform admin page** (the owner or someone they trust): invite or
  remove organisers, disable a party, see usage against the free daily limits and
  the health checks below. It shows nothing about guests' payments.
- **Approvals belong to each party's owner/admins**: ticket approvals, the
  "message all guests" email, reissues. Nothing is sent or approved in the
  platform owner's name.
- **Per-party limits**, so one party cannot use up the account-wide free
  allowances that every party shares (requests, D1 rows read/written, storage).
- **Unattended checks with alerts to the platform admin** (scheduled Worker; Cron
  Triggers are on the free plan): backup succeeded, every admission has its ledger
  record, nothing stuck "pending" in the change log, daily usage past about 50%,
  database size past 70%. The owner hears about a problem before a party does.
- **Still needs a person with Cloudflare access:** recovery after a database
  problem, applying migrations for future code changes, merging pull requests,
  rotating secrets. `docs/` will carry a short "who does what" list for these.

## Phase 4 features chosen (owner decision)

Party details, editable by the party's owner/admins at any time: name,
description, start and end time with the party's time zone, venue, address, map
link, rules, capacity, people per ticket, payment instructions. Every edit goes
through the change log and ledger. Changing the time or place can queue a notice
to every guest (outbox, approved by the party owner).

Address modes (owner chooses per party; the server decides, a hidden address
never reaches the browser early, times are stored as UTC instants plus the
party's IANA time zone):

- **Public:** shown on the party page.
- **Sent with ticket:** on the ticket page and in the ticket email once released.
- **Revealed at a time:** ticket holders only, from a set date and time, with a
  countdown before.
- **Manual reveal:** hidden until the party owner presses "Reveal now".

Honest limit: once revealed, a guest can share the address.

Chosen extras (numbers from the brainstorm):

- **2 Approval queue:** screenshot zoom, approve or reject in bulk, rejection
  reason shown to the guest.
- **3 Close at capacity:** ticket requests close automatically when the party is
  full (no sales-window times).
- **6 Guest list export:** a spreadsheet (CSV) downloaded in the browser by the
  party's owner/admins. Not written to anyone's Google Drive (party owners'
  Google accounts are never used).
- **7 Message all guests:** one message to every ticket holder through the email
  outbox, sent only after the party owner approves it. No emojis.
- **11 Map button and countdown:** countdown before the reveal; address and a
  maps link after it.
- **12 Resend my ticket link:** by email, rate-limited; the answer is the same
  whether or not the address has a ticket (no way to probe who is going).
- **13 Name transfer:** the party owner changes the name on a ticket; this
  reissues it and the old QR stops working.
- **14 Save QR to photos + brightness hint** (already a frontend requirement).
- **15 Big result screens, distinct sounds and vibration** for admit, used and
  stop (frontend).

## Workstream B: organisers, party creation, site owners (Phase 4)

Built on branch `claude/p4-b-organisers` (base c1da976). Only tested locally
(workerd + local D1 in `npx vitest run`); nothing ran against Cloudflare.

**Naming (owner decision):** the top level is the **site owner** everywhere a
person reads it (pages, API texts, docs, `setup.bat` step 14
"create-site-owner"). Kept as before, to avoid churn in storage and routes: the
table `platform_admins` (change-log entity `platform_admin`), the route prefix
`/api/platform`, the sign-in route `/api/auth/platform/start`, the page
`/platform` and the cookie `__Host-sahra_p`.

**What it does**

- **Site owners.** The first is added by the owner with `setup.bat` step 14
  (`node scripts/ops.mjs create-site-owner`; production asks for PROD). It
  writes one row (email, no Google account yet, 14-day sign-in window) plus an
  audit row with `wrangler d1 execute --remote --file`; running it again never
  duplicates a site owner (an unlinked one gets a fresh 14 days). The SQL is
  built by `scripts/site-owner-sql.mjs`; the tests run exactly that SQL locally.
- **Platform sign-in** at `/platform` (`POST /api/auth/platform/start`, same
  callback as staff). Same mechanisms as staff: state, nonce and PKCE in the
  sealed attempt cookie (it carries a sealed "platform" flag), no database write
  before a verified Google response, the same auto-link rules (verified Gmail,
  or Workspace with a matching hd; afterwards by Google account id only), the
  same read-only cap (10 sessions per Google account per rolling hour, counted
  from session rows), session token stored as SHA-256, HttpOnly Secure
  SameSite=Strict `__Host-sahra_p` cookie, Origin + CSRF on every change.
- **Organisers by invitation.** A site owner invites by email; the first
  platform sign-in with that address links the organiser. Invitations expire
  (7 days default, 14 max) and are single use.
- **Party creation** (`POST /api/platform/parties`, organisers only): one batch
  inserts the party, makes the organiser its owner (staff row linked to their
  Google account) and writes both audit rows. The organiser check and the
  **party limit** are inside the INSERT: the organiser's ACTIVE (not disabled)
  parties must be fewer than `organisers.party_limit` (default **1**; a site
  owner sets 1..20 with `POST /api/platform/organisers/:id/party-limit`, logged
  and audited; lowering it below the current count only blocks new parties).
  The organiser then signs in to the party on the normal staff sign-in page.
  Party ids follow the create-party rule (3-24 of a-z, 0-9, "-").
- **Site owner page**: invite and switch off organisers, set party limits,
  disable and re-enable parties, list and remove site owners, and per-party
  counts (staff, active sessions, tickets by status, outbox rows by status). No
  guest names, emails, answers or payment data.
- **Disabling a party**: intent first (ledger), then the control object is
  paused with pause_number + 1 (conditional on its rev, like an admission
  pause), then ONE main batch sets `parties.disabled_at`, admission paused with
  the same pause_number, revokes every session and every unused invitation of
  the party, with audit rows; then the change log. Scans answer "paused" (the
  control object is read first); staff Google sign-in skips a disabled party and
  the session INSERT refuses it; door join fails because the invitation is
  revoked.
- **Re-enabling a party** (`POST /api/platform/parties/:id/enable`): clears
  `disabled_at` in one batch with an audit row, logged; no intent (safe to
  lose). The party stays paused: admission state and the control object are
  untouched, old sessions and invitations stay revoked. Its owners sign in
  again, reopen admission themselves and invite door staff again. Re-enabling
  may leave an organiser above their party limit; that only blocks new parties.
- **Switching off an organiser**: intent first, then one batch: organiser
  disabled, every platform session of that Google account revoked, unused
  invitations revoked, audit. Their parties keep running (owner decision).
- **Removing a site owner** (`POST /api/platform/site-owners/:id/remove`):
  intent first (a removal must survive a recovery), then one batch: the row is
  disabled (never the caller, never the last active one: both inside the
  statement), every platform session of that Google account revoked, audit.
  Two site owners removing each other at once: exactly one is removed (the
  second statement finds its own session no longer valid).

**Storage (migration `migrations/0006_organisers.sql`, additive; not applied
anywhere yet)**

- `platform_admins` (site owners), `organisers` (with `party_limit`, default 1,
  CHECK 1..20), `organiser_invites`: logged entities (rev, logged_rev, last_op,
  last_action), in `Db.unlogged()` / `markLogged()`. Their change-log entries,
  audit rows and intents use party id `_platform` (party ids cannot start with
  "_").
- `organiser_invites` is a new table because `invites.kind` has a CHECK and
  `invites.party_id`/`staff_id` are NOT NULL; neither can change additively.
- `platform_sessions` is a separate table because `sessions.party_id` and
  `staff_id` are NOT NULL with foreign keys. Keeping them apart (and in a
  separate cookie) means a staff token is never found by a platform route and
  the other way round. A platform session belongs to a Google account; what it
  may do is decided on every request, and inside every write statement, from
  the active site owner / organiser rows with that account id. One person can
  be both site owner and organiser with one session.
- `parties.disabled_at`, `parties.organiser_id` (ADD COLUMN).
- Indexes: one active site owner / organiser per Google account (partial
  unique; this is what makes two sign-ins racing on one invitation give one
  link), unlinked organiser email, invitations by organiser, platform sessions
  by (google_sub, created_at) for the cap and revocation. Each is written only
  on these rare platform changes, never on the scan or join path. The active
  party count reads the organiser's parties without an index (parties is a
  small table).

**Shared files changed** (minimal): `src/db/index.ts` (unlogged/markLogged lines;
`activeStaffForSub` and `createGoogleSession` now skip a disabled party),
`src/routes/auth.ts` (platform start + one branch in the callback),
`src/app.ts` (route), `test/helpers.ts`, `test/unauth.test.ts` (23 cases; the
counted tables now include the platform tables and ledger intents).

**Rows per request (measured locally, small test database)**

| Request | D1 queries | rows read | rows written (main) | ledger rows written |
|---|---|---|---|---|
| GET /api/platform/me | 1 | 2 | 0 | 0 |
| POST /api/auth/platform/start | 0 | 0 | 0 | 0 |
| Platform callback, first sign-in (links organiser + invitation) | 5 | 31 | 10 | 2 |
| Platform callback, later sign-in | 4 | 25 | 3 | 0 |
| POST /api/platform/organisers (invite) | 4 | 20 | 10 | 2 |
| POST /api/platform/organisers/:id/party-limit | 4 | 16 | 3 | 1 |
| POST /api/platform/organisers/:id/disable | 4 | 27 | 5 | 2 |
| POST /api/platform/parties (create) | 4 | 26 | 10 | 2 |
| GET /api/platform/my-parties | 2 | 6 | 0 | 0 |
| GET /api/platform/parties (counts) | 2 | 13 | 0 | 0 |
| POST /api/platform/parties/:id/disable (no sessions or invitations) | 5 | 23 | 3 | 3 |
| POST /api/platform/parties/:id/enable | 4 | 16 | 3 | 1 |
| GET /api/platform/site-owners | 2 | 6 | 0 | 0 |
| POST /api/platform/site-owners/:id/remove (1 session) | 4 | 22 | 4 | 2 |

Rows read grow with the database: the change-log check (`unlogged()`) scans the
parties, staff, invites and the three platform tables on every change (as
before), and the counts page reads every ticket, session and outbox row once
(GROUP BY; opened by hand, not polled). Disabling a party also writes one row
per revoked session and two per revoked invitation (row + audit), and one
change-log entry per invitation; more than 20 pending entries answer "pending"
and the retry continues. Requests without a session write nothing (all 23 new
unauthenticated cases).

**What local tests cannot prove**

- The real Google sign-in for a platform account (the callback is the same as
  staff, but needs a real sign-in on staging once).
- The ops step on a real database: its SQL is tested locally, `wrangler d1
  execute --remote` itself is not run (workers never run --remote).
- D1's real rows-read figures on larger tables, and CPU per new endpoint on
  staging (step 12 will list the new routes once they get traffic).
- Concurrency: the races (invitation link, party limit, mutual site owner
  removal) are tested against local SQLite through D1's batch (serialized
  transactions), which is how D1 runs them, but not under real load.

**Open points**

1. Recovery (coordinator, at integration) must learn the new entities: the
   `party_disabled`, `organiser_disabled` and `site_owner_removed` intents, and
   the `_platform` party id in the change log. Party limit changes and
   re-enabling have no intent (losing them in a recovery is safe).
2. Site owners can only be added with the ops step (no web invitation for site
   owners).
3. Non-Gmail, non-Workspace organiser addresses cannot sign in until email
   confirmation exists (same as staff).
