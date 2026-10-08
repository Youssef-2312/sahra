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

## Workstream A: party details, address modes and reveal

**Built** (branch `claude/p4-a-party-details`):

- `migrations/0005_party_details.sql`: additive columns on `parties` (description,
  starts_at, ends_at, time_zone, venue_name, address, map_url, rules,
  payment_instructions, address_mode, reveal_at, revealed_at, address_locked_at). No
  new index. Existing parties default to `address_mode = 'manual'` with nothing
  revealed (the most closed mode). `parties` was already a logged entity, so the
  change log entry (`SELECT *`) now carries the new columns with no change to
  `Db.unlogged()`.
- `src/party/details.ts`: `visiblePartyDetails(party, viewer, now)`, pure, with
  `viewer = { kind: "public" } | { kind: "ticket", status, released, onHold }`.
  "The place" is venue name + address + map link, hidden together (venue name is
  hidden too, because it can give the place away). Shown only in `public` mode, or
  to an approved, released, not-on-hold ticket in `with_ticket`, `at_time` from
  `reveal_at` on (UTC instants; the zone never matters), or `manual` once
  "Reveal now" was pressed. Otherwise the three are null and
  `reveal = { mode, at? (at_time only), waiting_for: "ticket" | "time" | "owner" }`
  for the countdown. Every view is built from an allow-list. Signature is stable
  for workstream C.
- `src/party/time.ts`: IANA zone check (offsets like "+02:00" refused), local wall
  time to UTC (`*_local` fields, "YYYY-MM-DDTHH:MM" in the given zone; a time
  skipped by a DST change is refused, a repeated one takes the earlier instant),
  formatting for emails.
- `src/routes/party.ts` (`/api/party`):
  - `GET /` owner/admin: all details and settings; door: name, times, place
    (always, whatever the mode).
  - `POST /details` owner/admin + CSRF: only the fields sent change; `null` clears.
    Unknown fields, emojis, control characters, non-https map links (or with
    user:password) are refused. Inside the UPDATE statement: session valid; end
    after start; `at_time` needs a reveal time; once `address_locked_at` has passed,
    venue/address/map link and the lock itself cannot change (other fields can);
    a new capacity must be >= places held (people on pending + approved tickets).
    A request that changes nothing writes nothing (so a retry after "pending" only
    completes the change log write). rev + last_op + audit + `flushChangeLog`.
  - `POST /reveal` owner/admin, manual mode only, idempotent.
  - `GET /preview` owner/admin, read-only: what a public or ticket viewer would see.
  - `GET /public/:id` no session, one primary-key read, zero writes.
- "Notify guests" (`notify_guests: true` with a time or place change): one outbox
  row per approved, released ticket with an email (kind `party_notice`,
  `awaiting_approval`, plain text) in the same batch, via one `INSERT ... SELECT`
  (a statement per guest would hit D1's 50 queries per request). Ids are
  `notice:<op>:<ticket>`, so an edit can never queue a guest twice. Capped at 1,000
  rows per edit; the answer reports `notices_queued` and `notices_not_queued`.
  The text never contains the place (guests may not be allowed to see it; it points
  to the ticket page), and shows new times in the party's zone.
- Test page `public/party.html`: edit, Reveal now, preview public and ticket views.
- Tests `test/party.test.ts` (23) + 8 cases in `test/unauth.test.ts`.

**Measured locally** (workerd, from the request log line; rows read include the
shared test database's other rows, see below):

| Request | D1 queries | rows read | rows written (main) | ledger rows |
|---|---|---|---|---|
| public party page | 1 | 1 | 0 | 0 |
| GET details (door) | 2 | 4 | 0 | 0 |
| edit, any fields (no capacity) | 5 | 20 | 3 (party, audit, logged_rev) | 1 |
| edit repeated / retry with nothing new | 4 | 18 | 0 | 0 |
| edit capacity, accepted | 5 | 32 | 3 | 1 |
| edit capacity, refused (below held) | 2 | 18 | 0 | 0 |
| edit with notice, 2 guests | 6 | 71 | 5 (3 + 1 per guest) | 1 |
| reveal now, repeat | 3 | 32 | 0 | 0 |

Rows read grow with table sizes: `flushChangeLog` scans parties/staff/invites for
`rev > logged_rev` (existing behaviour), and a capacity edit or a notice reads
every ticket row, because `tickets` has no index on `party_id` (0002). Only edits
pay this, never the public page or the scan path. If workstream C adds an index on
`tickets(party_id, ...)`, these reads drop to the party's own tickets.

**What local tests cannot prove:** D1's real limits on a single `INSERT ... SELECT`
of 1,000 rows (time, statement size) and real CPU time of the routes (Intl time zone
formatting runs only on edits with local times or a notice, not on the public
page); that workerd's ICU time zone data matches the browser's; the test page by
hand in a browser.

**Owner / coordinator to decide:**

- Disabled parties (workstream B): the public page should answer 404 for them;
  `GET /api/party/public/:id` does not know about disabling yet.
- Notices link to "your ticket page"; the signed link per guest belongs to
  workstream C and could be added to each row's text then.
- Approving and sending `party_notice` rows (outbox sender, approval screen) is
  not built here.
- Edit history page: the audit rows (`party_edited`, detail = changed field names)
  and the change log hold it, but neither has an index by party; a history view
  needs one (a few rows written per change) or reads the whole table.
- Whether a manual reveal should be undone when the mode changes away and back
  (today `revealed_at` stays set once pressed).
- Address edits and reveals do not write a change intent (src/changes.ts): losing
  one in a recovery hides or reverts the place, it never opens access to a ticket.
