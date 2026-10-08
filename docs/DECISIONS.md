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

## Owner decisions, 2026-10-08

- **Halloween-26 stays on Vercel as it is.** No import, no compatibility
  endpoints; nothing in Sahra reads or touches it.
- **Email:** the platform's own Gmail over SMTP (app password, Cloudflare secret),
  Brevo free as fallback. No real email until the owner approves a staging send test.
- **"Site owner"** is the name for the top level (the code's "platform admin"):
  the owner of the website, optionally one trusted backup person. Invites
  organisers, sets how many parties each may create, can switch off an organiser
  or a party and turn a party back on, can remove another site owner (never the
  last one).
- **One party per organiser by default**; only a site owner can raise it per person.
- **Switching off an organiser leaves their party running.**
- **A secret address hides the venue label too** (venue name, address and map link
  together); the party name is always visible.

## Controlled recovery (Phase 3)

- `scripts/recover.mjs` (setup.bat step "Recovery") runs the procedure of brief
  section 8.3 with the owner's own Cloudflare login: maintenance on (secret
  `MAINTENANCE`: every API request answers 503, scanners say can't verify), pause
  every party, complete and verify the ledger, Time Travel restore to a moment
  the owner types, replay (newest rev per entity wins), hold anything
  unconfirmed, end every session, revoke every unused invitation, sync
  pause_number, final check, maintenance off. Parties stay paused until reopened.
  The same engine (`src/recovery/`) runs in the tests.
- **Holds:** when the main database cannot be checked, every ticket or staff
  member with an unconfirmed intent (`src/changes.ts`) is held; a held ticket
  cannot be admitted ("on hold, ask the owner"), held staff are disabled. The
  party owner releases each hold with a reason (`/api/recovery/...`, audited).
- **Not covered by intents (deliberate):** scans. A scan whose ledger record never
  arrived never showed green, so by the green-screen rule that guest was not
  admitted. When the main database is reachable (the normal case), such
  admissions are copied into the ledger before the restore and the ticket stays
  used. Option for later: an intent per scan (+1 ledger row per scan).
- After a restore, audit rows and outbox rows newer than the restore point are
  lost (the change log keeps the history); emails may be sent twice, which is
  harmless (every email links to the same ticket page).
- **Checkpoint C, live on staging (2026-10-08):** run 1 admitted 50 + 10 race tickets;
  backup point 00:34:40Z; run 2 admitted 50 + 10 more (main database and ledger:
  592 admissions = 592 records). `recover.mjs staging`: maintenance on and confirmed;
  917 rows checked before the restore, 0 mismatches; Time Travel restore to the
  backup point; 96 entries replayed, 821 already current; 0 holds; 13 sessions
  ended; party paused and pause_number synced; final check OK; maintenance off.
  After reopening: all 100 saved tickets (50 before, 50 after the backup point)
  scanned again and every one said "used"; ledger check: 0 reopened.
  Not proven live: the "main database unreachable" path (holds from intents) is
  tested locally only, as is recovery of site owners and organisers (Phase 4).
