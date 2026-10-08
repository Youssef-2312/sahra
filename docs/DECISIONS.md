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
## Workstream D: sending email (Phase 4)

**What was built.** `src/email/` and `src/routes/outbox.ts`, migration
`0008_email.sql`, the Worker's `scheduled` handler (`src/index.ts`), test page
`public/outbox.html`.

- **Sender (once-a-minute cron).** Needs this in `wrangler.jsonc` (top level and
  `env.staging`): `"triggers": { "crons": ["* * * * *"] }`. Each run: with no
  provider configured it returns without touching the database (rows stay
  queued, no error loop). Otherwise one "anything due?" read; if something is due,
  it reads the provider counters and claims at most 3 rows with ONE conditional
  UPDATE (`queued`, or `sending` past its 10-minute claim deadline, ->
  `sending`, fresh `claim_op`, `attempts + 1`, RETURNING). D1 runs statements one
  at a time, so two overlapping runs never claim the same row (tested). Each
  result is written right after its send, conditional on our `claim_op`.
- **Providers, in the owner's order:** (1) the platform's own Gmail account over
  SMTP (`smtp.gmail.com:465`, implicit TLS via `connect()` from
  `cloudflare:sockets`, AUTH PLAIN or LOGIN with a Gmail app password); (2) Brevo
  free (HTTPS API) when Gmail definitely did not take the message (login refused,
  connection failed, temporary refusal) or is at its cap. A party owner's Gmail is
  never used. One SMTP connection per run, reused for its emails, QUIT at the end.
- **Results.** Sent -> `sent` (`provider`, `sent_at`). Unknown (connection lost or
  timeout after the end of DATA, Brevo 5xx or network error) -> no fallback (it
  could duplicate), back to `queued` with backoff 2 min x 2^(n-1), at most 2 h,
  times a random 0.5-1.0. Permanent refusal (bad recipient, Brevo 400) -> `failed`.
  After 6 attempts -> `failed` with `last_error`; a row stuck in `sending` on its
  last attempt is failed, not retried. Errors are single-line, at most 200
  characters, and have the app password / API key removed (tested).
- **Duplicates** are possible after an unknown result or a reclaimed stuck row
  (acceptable: every email links to the same ticket page). Over Gmail the
  Message-ID is the outbox id, the same on every retry.
- **Caps** (`email_quota`, one row per provider per UTC hour; rolling 24 hours,
  because Gmail's limit is rolling): Gmail 450 / 24 h (its limit is about 500),
  Brevo 280 / 24 h (300 on the free plan), 10 per minute each. Gmail's own
  "daily limit" reply (5.4.5) fills its cap for 24 hours. Overlapping runs can
  overshoot a cap by at most one batch (3); the margins cover that. Both providers
  at cap -> nothing is claimed.
- **Content checks before any provider sees a row:** safe recipient address (no
  header or SMTP injection), no emojis (same check as `outboxInsert`), no line
  breaks in the subject. Message: plain text, UTF-8 subject as RFC 2047 encoded
  words, body quoted-printable, CRLF, dot-stuffing, no List-Unsubscribe, no HTML,
  no tracking.
- **Endpoints (owner or admin; door staff get 403; Origin + CSRF on POST; the
  session check is inside each statement):** `GET /api/outbox?status=&before=`
  (50 per page, newest first, cursor `created_at.id`), `POST
  /api/outbox/approve` and `/api/outbox/cancel` with `{ids: [...]}` (up to 500)
  or `{all_awaiting: true}`, and `POST /api/outbox/:id/approve|cancel`.
  Approve: `awaiting_approval` -> `queued` (sets `approved_at`, `approved_by`).
  Cancel: `awaiting_approval` or `queued` -> `cancelled` (`cancelled_at`,
  `cancelled_by`); a row being sent cannot be withdrawn. Rows awaiting approval
  are never claimed by the sender (tested). Outbox rows are not a logged entity
  (no change log), and approvals write no audit row: who approved/cancelled is on
  the row itself.

**Rows read/written (measured locally, D1 meta):**

| Action | Read | Written |
|---|---|---|
| Producer adds one outbox row | - | 3 (row + 2 index entries; was 1 before this migration) |
| Cron run, nothing due | 4 | 0 |
| Cron run, 1 email | 24 | 5 |
| Cron run, 3 emails | 38 | 15 |
| Cron run, no provider configured | 0 (no query) | 0 |

Per email sent: 5 rows written (claim: row + `outbox_due` entry; result: row +
entry; the hour counter). An idle day of cron runs reads about 5,800 rows (1,440
runs x 4). Approve/cancel: 1 row + 1 index entry per changed row. The party list
reads one page through `outbox_party` (a status filter can read further).

**CPU (Workers Free: 10 ms per invocation, cron runs included).** At most 3
emails per run. Building one message (1.1 KB body, Arabic + ASCII) measured in
Node's V8: 1.2 ms the first time, 0.1 ms after. **Not measurable locally:** the
CPU cost of the TLS handshake and TLS records on a real socket (done by the
runtime, possibly counted), Gmail's real replies, latency and limits, and
Brevo's real API. These need a staging measurement (`wrangler tail` on the cron
invocations) once the owner approves a real send test. If a run comes near the
CPU limit, lower `EMAIL.batch` (src/email/sender.ts).

**What the owner must do (never a worker; no real email is sent until the owner
approves a real send test on staging):**

1. Use a Gmail account that belongs to the platform (never a party owner's).
   Turn on 2-Step Verification for it (Google Account -> Security).
2. Create an app password (Google Account -> Security -> 2-Step Verification ->
   App passwords), name it "sahra-staging". Google shows 16 characters once.
3. Staging first: add `"GMAIL_ADDRESS": "<the platform address>"` to
   `env.staging.vars`, then on your own computer run
   `npx wrangler secret put GMAIL_APP_PASSWORD --env staging` and paste the app
   password when asked (it is never committed, printed or sent to anyone).
4. Optional fallback: create a free Brevo account, verify a sender address, set
   `"BREVO_SENDER"` in vars and `npx wrangler secret put BREVO_API_KEY --env
   staging`.
5. Add the cron trigger above, deploy staging, queue one email to your own
   address, check it arrives and how it looks, and measure the cron run's CPU.
6. Production only after that, with a separate app password (`sahra-prod`).
   To stop all sending at once: delete the secrets (`wrangler secret delete`);
   rows then simply stay queued.

**Open questions for the owner/coordinator.**
- A restore of the main database to an earlier point can bring `sent` rows back
  as `queued` (they would be sent again) and approved ones back to awaiting
  approval. Should recovery cancel queued rows created before the restore point?
- Old `email_quota` rows (2 per hour at most) are never deleted; a later
  cleanup job can drop rows older than 2 days.
- Stopping non-essential email when the account-wide D1 write budget is in danger
  is left to the quota workstream (the sender can skip a run on a flag).
## Workstream C: guests and tickets (Phase 4)

Built on branch `claude/p4-c-guests`. Code: `src/guests/` (form, link tokens,
Turnstile, emails, `GuestDb`), `src/routes/guests.ts` (no session),
`src/routes/tickets.ts` (owner/admin), `src/storage/` (screenshots). Migrations:
`migrations/0007_guests.sql` (main) and `migrations-files/0001_files.sql` (the
files database). Test pages: `public/signup.html`, `public/ticket.html`,
`public/queue.html`.

### What it does

- **Guest sign-up** (`POST /api/guest/parties/:party/signup`, multipart): name,
  email, people (at most the party's `max_people_per_ticket`), the party's own
  questions (`parties.guest_form`, set by owner/admin through
  `POST /api/tickets/form`; answers stored as JSON in `tickets.answers`) and the
  payment screenshot (required / optional / none per party; default required).
  Order: Origin, `RL_AUTH` per IP (`signup:<ip>`), Content-Length limit, field and
  image checks, then **Turnstile before any database access** (missing secret,
  site key, unreachable siteverify -> 503; failure -> 403; all fail closed). Cloudflare's
  documented test secrets are refused unless `ENABLE_TEST_TICKETS = "1"`.
- **Retry without a second ticket:** the browser generates a 256-bit sign-up token
  and keeps it until the request is confirmed. Ticket id and screenshot file id
  are derived from it (SHA-256 with the party id), so a retry after "pending"
  writes nothing new and only finishes the change log. Every retry needs a new
  Turnstile token.
- **Capacity in the same statement:** the sign-up INSERT only inserts when people
  on pending + approved tickets + this request fit the party's capacity, and
  every approval UPDATE only approves when approved people + this ticket fit.
  Requests close automatically at capacity (sign-up answers 409 `full`; the
  public form shows `full: true`). Rejected and cancelled tickets free their places.
- **Screenshots** in a separate D1 database (binding `FILES`), BLOB bound as a
  parameter, at most 1,500,000 bytes (server-enforced; Content-Length is checked
  before the body is read), type taken from the first bytes (JPEG, PNG, WebP
  only). Served only by `GET /api/tickets/:id/screenshot` to the ticket's party
  owner/admin (door 403, other parties 404), `cache-control: no-store`. Without
  `FILES`, a sign-up with a screenshot answers 503 `uploads_not_configured`.
  The browser compresses to about 1600 px JPEG first.
- **Approval queue:** `GET /api/tickets?status=pending` (paged), approve / reject
  (with a reason the guest sees) / release for 1 to 20 tickets, each **one batch**.
  Approving sends nothing. Release ("Send QR") adds one outbox row
  (`ticket_released`, plain text, the guest's link) per ticket in the same batch,
  guarded by "this operation released this ticket", so a repeat or a ticket
  that was not released adds nothing. Per-ticket results: `done`, `already`, `refused`.
- **Cancel, reissue, name transfer:** `recordIntent` with the browser's op id
  before the main batch (intent not written -> 503 pending, nothing changed). The
  same op id on a retry is recognized (`already`). Cancel and reissue reuse
  `TicketDb.cancel` / `TicketDb.reissue`. Name transfer changes the name (and
  optionally the email) and bumps `qr_version` and `link_version` in one
  statement: the old QR is refused at the door and the old link stops working;
  the new link is emailed (outbox `ticket_link`) and returned to the owner/admin.
- **Guest ticket link:** `T1.<PARTY>.<K><TICKET>.<LINK_VERSION>.<SIG>`, HMAC
  with a per-party key from `LINK_MASTER_K<K>` (HKDF purpose "LINK"), 130-bit
  signature, key id for rotation (`LINK_KEY_ID`). It travels in the URL fragment
  (`/ticket.html#t=...`, never sent to a server) and reaches the API in the
  `x-sahra-ticket` header; the signature is checked before any database access.
  The page shows pending / approved / rejected (with reason) / cancelled /
  released, and the QR text only when approved + released + not on hold. Party
  details: only `{ id, name }` for now (TODO in `src/routes/guests.ts` for
  workstream A's `visiblePartyDetails`).
- **Resend my ticket link:** same answer whether or not the address has a ticket;
  `RL_AUTH` per IP and per party + address (hashed); Turnstile; one outbox row
  (`ticket_link`, up to 5 links) only when a ticket exists, and at most one per
  address per party per 10 minutes (the outbox row id is derived from party,
  address and the 10-minute window, so the check is a primary-key lookup).
- **Export:** `GET /api/tickets/export` (owner/admin, paged by ticket id, at most
  500 per page): guest, answers, status, who approved / rejected / released /
  scanned and when. The browser builds the CSV (cells starting with = + - @ are
  prefixed against spreadsheet formulas). Nothing goes to Google Drive.

### Rows read and written (measured locally, miniflare)

One request each, in a party with 10 tickets (`test/guests.test.ts`, "rows read
and written"). Main = sahra-prod, ledger = sahra-ledger, files = FILES.

| Request | D1 queries | rows read (main) | rows written main / ledger / files |
|---|---|---|---|
| Sign-up with screenshot | 4 (+1 files batch) | 47 | 4 / 1 / 1 |
| Approve 1 ticket | 4 | 16 | 4 / 1 / 0 |
| Release 1 ticket (with its email) | 5 | 20 | 4 / 1 / 0 |
| Guest ticket page | 1 | 2 | 0 / 0 / 0 |
| Scan of a new guest ticket (admit) | 1 | 18 | 2 / 1 / 0 (unchanged) |

- Sign-up writes: ticket + its index row + audit + `logged_rev`. Approve: ticket
  + index row (status changed) + audit + `logged_rev`. Release: ticket + outbox +
  audit + `logged_rev` (no index change). A bulk request of N tickets uses the
  same number of queries as one ticket.
- **New index** `tickets_party_status (party_id, status, people)`: lets the
  capacity sum, the queue and the export read only one party's tickets instead
  of every ticket. Cost: 1 extra row written per sign-up and per status change.
  The scan path changes none of its columns: an admission still writes 2 + 1
  (asserted in the test).
- Reads grow with the party: the capacity check reads the party's pending +
  approved tickets (up to its capacity) three times per sign-up and once per
  approval. Part of the sign-up and approval reads is the existing change-log
  flush, which scans the parties, staff and invites tables (not specific to
  this workstream).

### What local tests cannot prove

- The Turnstile widget and siteverify against real Cloudflare (tests use a fake
  that answers like the documented test keys), and that the widget works under
  the page's CSP (`public/_headers` relaxes script-src and frame-src for
  `/signup` and `/signup.html` only, with `! Content-Security-Policy` to replace
  the global policy). Check both on staging in a real browser.
- D1's real behaviour for 1.5 MB BLOB parameters and its row-size limit (miniflare
  accepted them), and the real rows-written counts (verify on staging).
- That two sign-ups at once on real D1 are serialized like in miniflare (D1
  documents one writer per database; the race tests here run against miniflare).
- Browser compression keeping InstaPay/Telda amounts readable (not tested).

### Owner actions and open questions

- Create the files database(s) (`sahra-files-1`, same EEUR location) for staging
  and production, add the `FILES` binding to `wrangler.jsonc`, and apply
  `migrations-files/` to them; until then uploads answer 503 (fail closed), so a
  party with the default "screenshot required" form cannot take sign-ups.
- Create a Turnstile widget per Worker (staging, production) and set
  `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET` (secret); set
  `LINK_MASTER_K1` (secret, at least 32 random bytes, base64url) if not already set.
- A screenshot stored for a sign-up that then found the party full stays as an
  orphan row in the files database (never served). A cleanup job and the 70% size
  warnings are not built yet.
- `TicketDb.approve` (src/db/tickets.ts) has no capacity check; nothing in this
  workstream calls it (approvals go through `GuestDb.approve`). Add the check or
  remove the method at integration.
- The guest does not get an email on sign-up (only the link on screen); "resend
  my link" covers a lost link. Adding a confirmation email costs 1 outbox row
  per sign-up.
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
## Workstream F: health checks, alerts and per-party limits (Phase 4)

Built on branch `claude/p4-f-health` (base e39097e). Only tested locally (workerd +
local D1 in `npx vitest run`); nothing ran against Cloudflare. Code: `src/health/`
(checks, alerts, estimate, site owner view), `src/limits/` (per-party counters),
the cron hook in `src/index.ts`, `GET /api/platform/health`, a "Health checks"
section on `public/platform.html`. Migration `migrations/0009_health.sql`. Tests:
`test/health.test.ts` (27) + 3 cases in `test/unauth.test.ts`.

**Checks and cadence.** The existing once-a-minute cron runs the checks on every
minute divisible by 15 (`ctrl.scheduledTime`), in their own `waitUntil` next to
the email sender, so email is not delayed. Nothing at all runs while
`MAINTENANCE = "1"` (no query; tested on both the handler and the check runner).
A lease row (`health_state.lease_until`, one conditional UPDATE) makes two
overlapping runs impossible; a run that died is taken over after 10 minutes.

| Check | What it does | Problem when |
|---|---|---|
| changelog | flushes rows with `rev > logged_rev` (parties, staff, invites, platform tables) exactly like `flushChangeLog` (idempotent, up to 3 x 20 entries per run); daily also tickets whose last change is not an admission (admitted tickets are normally `rev > logged_rev`: their record is the admission record) | the ledger refuses the write, or more than 60 are pending |
| admissions | admissions (`tickets.used_at`) since the last run's cursor, up to 2 minutes ago (a scan may still be writing its record), at most 200 per run, only for parties whose control object is open or changed since the cursor (the ledger's `party_control`, one row per party), then a primary-key range lookup per ticket in `change_log` for an `admitted` entry. Missing ids are remembered (up to 50) and re-checked every run | an admitted ticket has no admission record |
| outbox | counts via the `outbox_due` index | failed in the last 24 h; queued more than 1 h past due; "sending" 30 min past its claim deadline |
| db_size | `meta.size_after` of `SELECT 1` on DB, LEDGER and FILES (D1 refuses `PRAGMA page_count`, `SQLITE_AUTH`, tested) | a database at 70% of 500 MB, or all bound databases at 70% of 5 GB |
| backup | `health_state.last_backup_at` | older than 26 h; NULL is shown as "not set up" and not alerted |
| usage | the app's estimate of today's rows written (below) | at or above 50,000 (50% of 100,000) |

**For workstream E:** after each successful backup, write
`UPDATE health_state SET last_backup_at = <unix ms>, last_backup_note = '<short text>' WHERE id = 'main'`.
Until the first one is recorded, the backup check stays "not set up" without alerts.

**Alerts.** To every site owner row with `disabled_at IS NULL` (its `email`),
through `outboxInsert` (kind `health_alert`, queued, plain text, no emojis,
link to `/platform`). Per problem: one alert when it starts, again only after 6
hours if it persists, one "resolved" message when it clears; the 6-hour rule is
decided inside the `health_checks` upsert and each outbox row requires that this
run's op set `alert_op` (tested over 24 runs). Party owners are never emailed.
The daily run (first run at or after 06:00 UTC) sends each site owner a short
summary (kind `health_summary`): a missing summary is the only way to notice
that the checks themselves stopped. Outbox rows need a party
(`outbox.party_id REFERENCES parties`, enforced by D1, tested), so the migration
adds a reserved, disabled, paused party row `_platform` (the id the change log and
audit already use for site-level rows); it has no staff and no control object,
is hidden from the site owner's party list, and its first change-log flush
records it like any party. **If the alert emails cannot be sent** (no provider
configured, provider down), the outbox check itself goes red, but only the page
shows it: an email alert cannot report that email is broken.

**Discord (optional, extra channel).** The same alert, "resolved" and daily
summary messages are also posted to a Discord channel when the secret
`DISCORD_WEBHOOK_URL` is set; email through the outbox stays the primary
channel. Only `https://discord.com/api/webhooks/<id>/<token>` or the same on
`discordapp.com` is used; anything else counts as not configured and the page says
"NOT USED". The URL is never stored, logged, returned or shown (errors record only
"HTTP 503" or "network error: TypeError"). A message is a row in `health_discord`
(migration 0009), added in the same batch and under the same guard as the email
(so the same 6-hour rule), and posted after the batch: JSON `{"content": ...,
"allowed_mentions": {"parse": []}}`, plain text, no emojis, "@everyone"/"@here"
defused, at most 1,900 characters, with the check, its state, the summary, the time
in UTC and Africa/Cairo, and the page link (never guest, session or secret data).
At most 3 posts per run, oldest first. Network errors, 5xx and 429 stay pending
for the next run (a 429's `retry_after` is respected); a 4xx other than 429/408
(webhook deleted) or a message still failing 24 hours after it was created is
marked `gave_up` with its last error. Sent and given-up rows older than 8 days are
deleted by the daily run. Nothing is posted during MAINTENANCE. The page shows
"configured / not set / NOT USED", the latest message's state and how many wait.
Measured locally: a run with Discord configured and nothing to post makes one more
query (7 main queries, 27 rows read, 2 written, against 6 / 25 / 2 without); a run
posting 3 messages, 8 main queries, and each message writes 2 rows (insert +
result). Tests: success, 5xx and network error retried next run, 429 waits for
retry_after, given up after 24 hours, 404 given up at once, at most 3 per run,
invalid URLs ignored, no mentions, no emojis, length cap, daily summary once.

How the owner sets it (staging first, never a worker): in Discord, channel
settings -> Integrations -> Webhooks -> New Webhook -> Copy Webhook URL; then on
your own computer `npx wrangler secret put DISCORD_WEBHOOK_URL --env staging` and
paste it when asked. Check the platform page shows "Discord: configured" and that
the next daily summary (06:00 UTC) arrives in the channel; then the same for
production with `npx wrangler secret put DISCORD_WEBHOOK_URL`. Anyone holding the
URL can post to that channel: if it leaks, delete the webhook in Discord and set a
new one. To stop posting: `npx wrangler secret delete DISCORD_WEBHOOK_URL`.

**Per-party limits** (`src/limits/`, table `party_usage`, one row per party per
kind per UTC day). The counter is one UPSERT whose WHERE holds the cap (and, for
staff routes, the session check), written before the action's own batch: two
requests at once never both pass the cap (8 concurrent, cap 3: exactly 3 pass,
tested); a request refused later still counts (errs on the safe side). Answer:
429 `party_limit` with "This party has reached today's limit of N ... It resets
at 00:00 UTC."

| Kind | Where | Cap per party per day | Essential |
|---|---|---|---|
| signup | guest sign-up, after Turnstile, not for a retry of a stored sign-up | 1,000 | yes |
| resend_link | "resend my link", after Turnstile, counted whether or not the address has a ticket | 300 | yes |
| release | "Send QR", per ticket | 1,000 | yes |
| notice | party edit with `notify_guests` (up to 1,000 emails each) | 3 | no |
| outbox_approve | outbox approval request | 50 | no |
| export | export page (up to 500 tickets) | 200 | no |

Why these numbers: each kind on its own keeps one party at or below about 7-9% of
the account's 100,000 daily writes (sign-up 7 rows, release about 8, a notice up
to 3,000 + 2 per approved row); one party using every cap to the full could still
reach about 30%. Non-essential kinds also answer 429 `daily_budget` ("paused until
00:00 UTC; scanning is not affected") while the estimate is at or above 50,000;
sign-up, resend and release keep only their per-party cap. The scan path, door
join and every other route are not counted and never limited. This reduces the
risk; it is not a guarantee (requests without a session, Cloudflare's own request
limit and rows read are not covered, see "Accepted risks").

**The daily estimate** (`health_state.usage_est`, per UTC day) is built by the cron
from cheap aggregates, multiplied by measured rows per event: new audit rows x 6
(primary-key range; sign-up writes 7 per audit row, approval 5, a party edit 4),
new outbox rows x 3 (`outbox_party` index), admissions checked x 4 (2 main + 1
ledger + 1 margin for denials and retries), emails sent today x 5 (`email_quota`),
plus the run's own writes. Not counted: denied scans, session revocations, outbox
approvals, and anything on staging (the allowance is per account).

**Rows read/written (measured locally, D1 meta).**

| What | Main queries / read / written | Ledger queries / read / written |
|---|---|---|
| Health run, steady state (nothing changed) | 6 / 25 / 2 | 1 / 1 / 0 |
| Health run, first run (6 check rows created, 1 change-log entry flushed) | 7 / 26 / 9 | 1 / 0 / 1 |
| Health run with 200 new admissions (first run of that test: check rows created) | 7 / 452 / 8 | 2 / 602 / 0 |
| Per alert, per site owner | +3 written (outbox row + 2 index entries), +5 when sent | - |
| `GET /api/platform/health` | 2 / 18 / 0 | 0 |
| Sign-up (with the counter) | 5 / 52 / 5 (was 4 / 51 / 4) | ledger 1, files 1 (unchanged) |
| Release 1 ticket (with the counter) | 6 / 26 / 7 (was 5 / 24 / 6) | 1 (unchanged) |
| Scan, admit | 1 / 18 / 2 (unchanged) | 1 written (unchanged) |

Per day: 96 runs x 2 rows = about 192 rows written and about 2,500 main rows read
when idle, plus one summary per site owner (3 rows) and any alerts. Rows read grow
with the parties/staff/invites tables (the change-log check scans them for
`rev > logged_rev`, as every change already does) and, while parties are open,
with their tickets (index range on `party_id`) plus about 3 ledger rows read per
new admission. Bounded per run: at most 200 admissions; main queries at most 13
plus one per 40 parties open at once (lease, check rows, up to 3 change-log rounds
of 2 plus the daily ticket query, admissions, outbox, estimate, site owners, final
batch); ledger queries at most 5 (3 change-log writes, party list, one lookup
batch). Each run logs a line `{"evt":"health", ...}` with these counts.

**What local tests cannot prove.** Real D1 sizes and whether `meta.size_after`
matches the dashboard; the account's true daily usage (the estimate leaves out
the cases above, and staging shares the allowance); real CPU time of a cron run
(at most 200 admissions and a few small queries; measure with `wrangler tail` on
the scheduled invocations on staging); that alert emails arrive (no real email
here). The exact figures exist only in Cloudflare's dashboard or its GraphQL
Analytics API (`d1AnalyticsAdaptiveGroups`: rows read/written per database per
day). **Option for later (not built):** the owner creates a read-only API token
with "Account Analytics: Read" and stores it as a secret; the daily run would
then replace the estimate with the real account-wide numbers (one HTTPS request a
day, no D1 rows).

**Shared files changed (minimal):** `src/index.ts` (cron), `src/routes/platform.ts`
(the health route), `src/platform/db.ts` (the party list hides `_platform`),
`src/routes/guests.ts`, `src/routes/tickets.ts`, `src/routes/party.ts`,
`src/routes/outbox.ts` (one counter call each), `public/platform.html` and
`public/js/platform.js` (health section; also fixed `getElementById("owner")`,
the section id is `site_owner`, so the site owner section never showed),
`test/unauth.test.ts` (3 cases; counted tables now include the new ones),
`test/guests.test.ts` (release now makes one more query: the counter).

**Open questions.**
1. The reserved `_platform` party row (needed for the outbox foreign key) is data
   in a migration; accepted by the coordinator.
2. The caps and the 26-hour backup age are first guesses; the owner may change
   them in `src/limits/index.ts` and `src/health/index.ts` (`HEALTH`).
3. Recovery (`src/recovery/`) does not know `health_state`/`party_usage`; a restore
   brings back older counters and cursors, which only re-checks some admissions
   and may let a party do a little more that day.
4. Old outbox rows of `_platform` (alerts, summaries) are never deleted, like
   other outbox rows; a general outbox cleanup would cover them.

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

## Workstream E: backups outside Cloudflare (Phase 4)

Built on branch `claude/p4-e-backups` (base e39097e). Only tested locally (workerd
tests, Miniflare, a simulated Apps Script, a Drive folder on disk); nothing ran
against Cloudflare or Google.

**What was built**

- `src/routes/backup.ts`, `src/backup/`: four read-only GET endpoints for the
  platform owner's Apps Script. `/api/backup/schedule` (hourly or nightly and
  why), `/api/backup/manifest[?counts=1]` (exported and excluded tables with the
  reason, migrations, D1's measured size per database, optional row counts),
  `/api/backup/rows/:db/:table?after=&limit=` (one page by primary key, default
  200, at most 500 rows; composite keys use a row-value comparison; never
  OFFSET), `/api/backup/file/:id` (one screenshot's bytes with `x-sahra-sha256`
  and `x-sahra-size`).
- **Signature, checked before any database access:** HMAC-SHA256 with the secret
  `BACKUP_KEY` over `SAHRA-BACKUP-1`, method, host, path, raw query and a Unix
  time; refused when more than 5 minutes off, when signed for another path,
  query, host (staging vs production) or with another key. Missing or short key
  (under 32 bytes) -> 503 on every endpoint (fail closed). **Stateless, no
  nonces:** every endpoint is a read-only GET, so replaying a captured request
  inside its 5 minutes only reads the same page again, which the capture already
  showed; a nonce store would cost a database write per request.
- **Excluded from the backup:** `sessions` and `platform_sessions` (session token
  hashes; short-lived and every restore ends all sessions), `outbox` (email
  bodies carry guests' signed ticket links, which show the QR; a restore from
  Drive sends nothing again, guests use "resend my ticket link"), `d1_migrations`
  (recreated by the migrations; the names are in the manifest and the drill
  checks them). Kept: invitation token hashes and scan QR fingerprints (SHA-256
  of 256-bit / 130-bit-signed values; not usable to sign in or forge a code, and
  the change log already holds invitations in full), guest names, emails and
  answers (needed to restore tickets). No table holds a plaintext secret. A test
  fails when a migration adds a table that is neither exported nor excluded.
- **Not a snapshot:** pages are ordinary queries over minutes. The main tables go
  first, the screenshot list next, the ledger last, so the ledger is never older
  than the rows it covers; restoring = load the tables, then the recovery
  engine's replay (newest rev per entity wins). Tested: a guest admitted after
  the main tables were exported comes back as admitted through the ledger.
- **Restore** (`src/backup/restore.ts`, shared by the tests and
  `scripts/restore-drill.mjs`): only into fresh migrated databases (refuses a
  table that has rows), one parameterized INSERT per row, **one statement per
  screenshot with the bytes bound as a BLOB**; then every table is read back and
  compared, every restored screenshot hashed, and `src/recovery` verify / replay /
  verify run on the restored main database and change log.
- `backup/apps-script/Code.gs` + `README.md` (install steps), `appsscript.json`.
  Resumable state machine in Script Properties (tables page by page, part files
  of 5,000 rows gzipped, screenshots in batches of 20), each run stops after 5
  minutes and a one-off trigger continues 1 minute later; screenshots stored once
  and checked three times (Worker hash vs received bytes, size vs list, read back
  from Drive); summary with the measured database sizes; retention 48 hours +
  one per day for 30 days; email alerts (MailApp, own account) on failure, on a
  screenshot check failure, when no backup succeeded for 3 h (hourly mode) or
  30 h, and when the daily budget is used; at most one per problem per 6 hours.
- `scripts/restore-drill.mjs`: backup folder -> fresh local D1 (`wrangler d1
  migrations apply --local --persist-to <new dir>`, then the same files through
  Miniflare's D1 binding) -> load, compare, hash, recovery verify / replay; the
  largest screenshot is also read back through `wrangler d1 execute --local` and
  hashed. `scripts/backup-e2e.mjs`: the whole path locally (see below).
- Shared files: `src/app.ts` (route), `src/env.ts` (`BACKUP_KEY`),
  `vitest.config.ts` (test-only `BACKUP_KEY` and three empty restore databases),
  `test/env.d.ts`, `test/helpers.ts` (`backupGet`, `exportAll`),
  `test/unauth.test.ts` (8 cases). No migration.

**Schedule (Worker decides, script follows):** hourly while any party's admission
is open, on a party night (12 h before the start until 6 h after the end), or while
a party is "selling"; nightly otherwise (from 03:00 in the script's time zone).
"Selling" is approximated without reading tickets: some party is not switched off
and not over, and the newest audit row is under 24 hours old. The check reads the
parties table and one audit row.

**Measured locally** (workerd; rows from the endpoints' own log line `evt:
"backup"`, which counts main, ledger and files reads; `test/backup-cost.test.ts`):

| Request | rows read | rows written |
|---|---|---|
| one page of N rows (any table) | N (an index range; 500-row change-log page = 500) | 0 |
| one screenshot | 1 | 0 |
| schedule | parties + 1 | 0 |
| manifest without counts (10 parties, 4,000 tickets) | 100 | 0 |
| manifest with counts | 44,160 (one per row: COUNT(*) reads the table) | 0 |
| unsigned / bad signature / no key | 0 (no query) | 0 |

**Full backup at 4,000 tickets with screenshots** (synthetic rows, per ticket: 4
change-log entries, 4 audit rows, 1 scan, 1 screenshot; 10 parties, 50 staff;
44,060 rows in the backup): **92,232 rows read** with counts and every screenshot
downloaded (main 48,202, ledger 32,019, files 12,011), the same with 200- or
500-row pages. Split: the rows themselves about 44,100; the manifest counts
44,160; one per screenshot download (only NEW screenshots are downloaded after
the first backup). So an hourly backup (no counts, no new screenshots) reads about
44,100 rows, a nightly one about 88,000. **A day of hourly backups at that size is
about 1.1 million rows read, 22% of the account's 5 million per day.** A 500-row
change-log page is about 313 KB of JSON; serializing it took 0.5 ms (median) in
Node's V8, SHA-256 of a 1.5 MB screenshot 1.3 ms; Workers CPU per request is not
measurable locally.

**Apps Script runtime (an estimate, not measured):** a backup of 4,000 tickets is
about 120 requests (400-row pages) plus about 9 part files; at 0.3 to 0.5 s per
request and 1 to 2 s per Drive file, 1.5 to 2 minutes per run without new
screenshots, plus about 1.5 s per new screenshot. 24 hourly runs: about 40 to 50
minutes a day, inside the 90-minute trigger budget; the script itself stops
starting backups after 75 minutes in a day and emails the owner. A first backup
of 4,000 existing screenshots would take about 100 minutes, i.e. spread over two
days of runs: install the script before sales start. Drive use (estimate): about
3 MB gzipped per backup at 4,000 tickets, about 80 kept (about 250 MB), plus each
screenshot once (4,000 x 200 KB = 800 MB).

**Local end to end** (`node scripts/backup-e2e.mjs`, about 30 s): fresh local
databases; the Worker in Miniflare with random test keys; data through the real
routes (12 test tickets, 3 admissions, 4 sign-ups with screenshots of 1,500,
48,000, 210,000 and exactly 1,500,000 bytes, approve, release, cancel with its
intent); Code.gs itself in the simulation, with a 60 ms limit per run, so it
resumed 4 times (43 requests, 258 rows read, 0 written); each screenshot in
"Drive" with the uploaded SHA-256; a second backup copied only the one new
screenshot; the restore drill passed (14 tables identical, 5 screenshots hashed
after the restore, 1.5 MB screenshot identical also through wrangler, recovery
verify OK, replay 0 changes, 0 holds); the drill FAILS when one byte of a
screenshot copy is changed; a wrong key makes the run fail and sends one alert.

**Findings on D1 (local):** `PRAGMA page_count` is not allowed (SQLITE_AUTH), so
the size is D1's own `meta.size_after` (with `PRAGMA page_size`, 4096).
`hex()` of a 1.5 MB BLOB fails with SQLITE_TOOBIG (SQLite's string limit in D1,
the hex text is 3 MB), and an `X'...'` literal of it would be a 3 MB statement
(limit 100 KB): a SQL-dump round trip cannot carry the largest screenshots, so
the restore is file by file with bound parameters (as decided above), and the
drill reads the largest file back through wrangler in 500 KB slices.

**What the owner sets up** (details in `backup/apps-script/README.md`; staging
first, production later with its own key and folder):

1. `BACKUP_KEY` secret on staging (`node scripts/gen-secret.mjs` into a file
   outside the repository, `npx wrangler secret put BACKUP_KEY --env staging`).
2. A Drive folder in the platform owner's own account, not shared.
3. A new Apps Script project in that account with `Code.gs` and
   `appsscript.json`; Script Properties `BACKUP_URL`, `BACKUP_KEY`, `FOLDER_ID`
   (optional `ALERT_EMAIL`); run `setup` (grants access, installs the hourly
   trigger), then `backupNow` once.
4. Download one backup folder and `screenshots/`, run
   `node scripts/restore-drill.mjs <folder>`: it must say "Restore drill OK".
   This is the brief's "prove early" step on real data.

**What local tests cannot prove:** real Drive behaviour and speed, real Apps
Script quotas (6 minutes per run, 90 minutes per day, UrlFetch 20,000 per day,
MailApp) and the runtime estimate above; that Google's UrlFetch leaves the query
string and headers as signed (the query uses only unreserved characters for this
reason); real D1 rows-read figures and database sizes on Cloudflare (verify on
staging with `wrangler tail`: the `evt: "backup"` lines), CPU per backup request
on Cloudflare, D1's real behaviour for 1.5 MB BLOB reads; how much an hourly
backup during a party night slows scans (each page is one short indexed query;
not a D1 export, so it does not block the database, but it shares it). The restore
here is into LOCAL databases only; restoring into new remote D1 databases needs the
owner's credential and a parameterized writer for BLOBs (wrangler's `d1 execute`
cannot bind parameters), which is not built.

**Open questions for the owner/coordinator**

1. Rows read: hourly backups all day at 4,000 tickets use about 22% of the
   account's daily reads. Options: accept; or hourly runs copy only the ledger
   (change log, intents, control objects: about 40% of the rows, enough to rebuild
   every logged entity by replay) and the full tables nightly; or let the quota
   workstream skip backups past 50% of the daily limit (backups are non-essential).
2. Outbox rows are not in the backup (they carry ticket links). Emails awaiting
   the party owner's approval are lost in a restore from Drive. Acceptable?
3. If the script itself stops (trigger deleted, Google account problem), it
   cannot email. The planned Worker health check "backup succeeded" cannot see
   backups (the endpoints write nothing); it could if the script reported each
   finished backup to a small signed write endpoint (one row per backup). Decide
   whether that write is wanted.
4. Only one files database (`FILES`) is exported; when `sahra-files-2` exists,
   the export and restore need its binding added to the table list.
5. Trashed Drive folders count against the Drive quota for 30 days.
