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
- **Staging-only test endpoints** (`/api/test/tickets`, `/api/test/door-invite`)
  answer 404 unless `ENABLE_TEST_TICKETS = "1"` (staging only); a test checks it.
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
