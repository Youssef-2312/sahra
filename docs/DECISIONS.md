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
