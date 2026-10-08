# Sahra: system summary for review (2026-10-08)

A summary of what is built, how it works, what was measured, and what is not
proven yet. Detailed decisions: `docs/DECISIONS.md`. Owner steps: `docs/SETUP.md`.
No secrets are in this document or in the repository.

## 1. What Sahra is

A multi-party ticket platform for private, non-commercial house parties (about
10 parties, 2,000 to 4,000 guests in total). Guests sign up per party and pay by
InstaPay or Telda, uploading a payment screenshot. A party admin approves, then
separately releases the ticket (QR code). Door staff scan QR codes at the door.
After handover the owner steps back: invited organisers run their own parties and
the owner (the "site owner") only intervenes when something goes wrong.

Status: backend only. Every page is a bare, unstyled test page; the frontend
design is the next phase.

## 2. Non-negotiable rules (from the brief)

1. A QR code used twice is the worst failure. When in doubt, fail closed: the
   scanner shows "can't verify" or "paused", never green.
2. Halloween-26 (a separate live party on Vercel) is never touched. Owner decision:
   it stays on Vercel as it is; nothing in Sahra reads or imports it.
3. Buy nothing: free plans only (`*.workers.dev`).
4. No passwords stored, no password hashing. Never weaken security to fit a free tier.
5. No offline scanner mode; Google Drive is never a live database; party owners'
   Gmail accounts are never used.
6. No emojis in UI or emails.
7. Every action on the owner's accounts needs the owner's approval.
8. Wording: "only one successful database redemption per ticket" (not "double
   entry is impossible"); "designed to stay within free allowances".

## 3. Architecture

- **Runtime:** one Cloudflare Worker (TypeScript, Hono `hono/tiny`). Static pages
  are Workers static assets (they do not invoke the Worker or count as requests).
- **Two separate Workers:** production `sahra` (deploys from `main`, only through
  pull requests the owner merges) and `sahra-staging` (deploys from `staging`). All
  live tests and load tests run on staging only. Separate Google OAuth clients and
  separate secret values per Worker.
- **Storage: Cloudflare D1 only** (no R2), all in region EEUR:
  - main database (`sahra-prod` / `sahra-staging`): parties, staff, invitations,
    sessions, audit, tickets, scans, outbox, organisers, site owners, health state;
  - ledger database (`sahra-ledger-prod` / `-staging`): append-only change log,
    change intents, per-party admission control objects. It protects against
    controlled restores of the main database; it is NOT an independent backup (same
    account and quotas);
  - files database (`sahra-files-1` / `sahra-files-staging`): payment screenshots
    as BLOBs.
- **Deploys** run only `wrangler deploy`. **Migrations** are applied by the owner
  from their own computer (setup.bat), staging first, production before merging.
  All migrations are additive only.
- **Free plan limits that shape the design:** 10 ms CPU per request, 50 D1 queries
  per request, 100,000 Worker requests/day and 100,000 D1 rows written/day and
  5,000,000 rows read/day for the whole account, 500 MB per database.

## 4. Sign-in and sessions (Phase 1)

- **Staff sign-in with Google** (OIDC authorization code flow with state, nonce and
  PKCE). Nothing is written to the database before a valid Google response: the
  state/nonce/PKCE travel in a sealed AES-256-GCM cookie (HKDF-derived key, key
  id, expiry, purpose bound as additional data). Google's signing keys are cached
  per isolate.
- **Account linking:** only verified Gmail addresses or a Google Workspace domain
  matching `hd` auto-link to an invitation; after that the account is matched by
  Google's `sub` only.
- **Door staff** join through a one-time 256-bit invitation link (no Google
  account needed). The browser generates the session value, so a retry is safe;
  the invitation is consumed in one atomic batch (8 simultaneous joins give exactly
  one session).
- **Sessions:** only the SHA-256 of the token is stored. Cookies are `__Host-`,
  HttpOnly, Secure, SameSite=Strict. CSRF token = SHA-256("sahra-csrf-v2|" + raw
  token), plus an Origin check on every state change. At most 10 sessions per
  person per hour (checked read-only).
- **Every rule is inside the SQL statement that makes the change**, including "is
  this session still valid", so a revoked session cannot slip through between a
  check and a write.
- **Unauthenticated requests write nothing** (a test covers every registered
  route), except guest sign-up (Turnstile-protected) and door join with a valid
  invitation.
- **Rate limits:** scans keyed per scanner session (not per IP: door phones share
  Wi-Fi), sign-in/join per IP.

## 5. Scanning (Phase 2)

- **QR format:** `S1.<PARTY>.<K><TICKET16>.<VERSION>.<SIG26>`, Crockford base32,
  HMAC-SHA256 with a per-party HKDF key and key id, 130-bit signature. Fits QR
  version 4 at level M. The signature is checked before any database access.
- **Redemption:** one main-database batch: a conditional ticket update (approved,
  released, current QR version, unused, not on hold, no scan row with this scan id,
  party open with the control object's pause number, session valid), then the
  scan row with its final outcome, then a read-back. Admit = 2 rows + 1 ledger row.
- **Green-screen rule:** after the main batch, ONE ledger batch writes the
  admission record (idempotent) and re-reads the party's control object. Green
  only if that succeeded and the party is still open with the same pause number;
  otherwise "recording" (retry with the same scan id finishes it) or "paused".
- **Pause/open:** the control object lives in the ledger, changed only by a
  conditional write on its revision; the main database keeps a copy, and both must
  agree before anyone is admitted.
- **CPU:** a startup warm-up compiles the scan, join and session code paths at
  Worker startup against an in-memory stand-in (no real data), so a fresh isolate's
  first scan is cheap.

## 6. Change log and recovery (Phase 3)

- **Change log:** every change to a party, staff member, invitation, ticket,
  organiser or site owner bumps the row's revision and writes its full state to
  the ledger (entity + revision) before the change is confirmed to the user;
  unconfirmed changes answer "pending, retry".
- **Change intents:** changes that would be unsafe to lose in a recovery (ticket
  cancel, reissue, name transfer; staff role change or disable; disabling a party,
  organiser or site owner) first write an intent to the ledger. If that write
  fails, the change is not made.
- **Replay rule:** newest revision per entity wins; an older entry never
  overwrites a newer state.
- **Controlled recovery procedure** (`scripts/recover.mjs`, setup.bat 20/21),
  run only with the owner's own Cloudflare login (no Worker can restore a database):
  1. maintenance switch on (every API request answers 503; scanners say "can't verify"; email and health jobs stop);
  2. pause every party (control objects);
  3. copy every committed change and admission not yet in the ledger into it, then verify row by row;
  4. restore the main database with D1 Time Travel to a moment the owner chooses;
  5. replay the change log;
  6. hold anything that cannot be confirmed (a held ticket cannot be admitted; held staff/parties/organisers are switched off) until an owner resolves each one with a reason (audited);
  7. end every session and revoke every unused invitation (everyone signs in again);
  8. set each party's pause number to its control object's; final check; maintenance off. Parties stay paused until reopened.

## 7. Phase 4 (built, on staging, not yet merged)

- **A. Party details:** name, description, times with the party's time zone, venue,
  address, map link, rules, capacity, payment instructions. Address modes: public,
  sent with ticket, revealed at a set time (countdown before), manual reveal. The
  server decides; a hidden address never reaches the browser early. Optional
  "notify guests" of a time/place change (email, owner approval required).
- **B. Organisers and site owner:** only organisers invited by a site owner can
  create parties (1 per organiser by default, a site owner can raise it). A site
  owner can disable an organiser (their party keeps running), disable a party
  (pauses it, ends its sessions) and turn it back on, and remove another site owner
  (never the last one). Separate sign-in and cookie for site-level pages.
- **C. Guests and tickets:** guest sign-up per party (own questions, people per
  ticket, payment screenshot as a BLOB, Cloudflare Turnstile verified before any
  write), hard capacity enforced inside the sign-up statement and the approval
  statement (pending + approved people), requests close at capacity, approval
  queue (bulk approve/reject with a reason the guest sees), release ("Send QR")
  separate from approval, cancel, reissue, name transfer (old QR stops working),
  guest ticket page by a signed link in the URL fragment (QR only when approved,
  released and not on hold), "resend my ticket link" (same answer whether or not
  the email exists), guest list export (CSV built in the browser).
- **D. Email outbox:** rows are added in the same batch as the change that causes
  them; a once-a-minute cron sends a few at a time. Provider order: the platform's
  own Gmail over SMTP (app password, Cloudflare secret), Brevo as fallback. Daily
  and per-minute caps, retries with backoff, overlapping runs never send one row
  twice. No real email has been sent; it needs the owner's approval of a test send.
- **E. Backups outside Cloudflare:** a Google Apps Script on the owner's account
  pulls a signed (HMAC) read-only export into the owner's Drive: hourly = ledger +
  new screenshots, nightly = everything. Resumable, each screenshot verified by
  size and SHA-256, alerts on failure, retention policy. Session tables and email
  bodies are excluded. A restore drill loads a backup into fresh local databases
  and proves identical rows and byte-identical screenshots, then replays.
- **F. Health checks and limits:** every 15 minutes: admissions without a ledger
  record, change-log entries stuck pending, outbox failures, database size over
  70%, backup older than 26 h, daily write estimate over 50%. Alerts go to every
  site owner by email and to a Discord channel (webhook URL is a Cloudflare secret),
  at most once per problem per 6 h, plus "resolved" and a daily summary. Per-party
  daily caps on sign-ups, emails, notices, exports; non-essential work stops at 50%
  of the daily budget. The door and scanning are never limited by these.
- **H. Load test script:** being written (see section 10).

## 8. Measured results (real Cloudflare, staging)

- **Live concurrency checks:** 8 simultaneous joins on one invitation give exactly
  one session (30/30 rounds); per ticket: first scan admitted, same-id retry
  returns the stored admit with no second redemption, second scan "used", forged
  code stopped (100/100); 8 phones scanning one ticket at the same moment give
  exactly one admit (30/30).
- **Ledger check:** every admission has its ledger record (latest: 592 = 592).
- **CPU per request (Workers Free limit 10 ms), 498 requests:** warm scan
  p50 2 / p95 4 / p99 5 / max 5 ms (n = 308); warm join p99 4 ms (n = 144);
  cold scan max 6 ms; no request exceeded the limit.
- **Client round trip** (from a cloud sandbox, includes its network): scan p50
  about 315 ms, p95 about 430 ms.
- **Checkpoint C (recovery rehearsal):** 60 admissions, backup point, 60 more;
  recovery restored the main database to the backup point with Time Travel,
  replayed 96 entries, 0 holds, final check OK; afterwards all 100 saved tickets
  (before and after the backup point) said "used", 0 reopened.
- **Local test suite:** 367 tests passing in workerd (Cloudflare's runtime),
  including deliberate rule breaks that the tests must catch.

## 9. Accepted risks and known limits

- **Request flooding:** anyone can send requests to `/api/*`; exhausting the
  account's 100,000 requests/day stops every Worker including the door. There is no
  free fix without a domain we control. The door is not protected from this.
- **Daily D1 quotas** are account-wide; app-level limits reduce the risk, they do
  not remove it.
- **The ledger is not an independent backup**; the Drive copy is the only copy
  outside Cloudflare.
- **Only tested locally so far:** recovery when the main database is unreachable
  (holds from intents); Phase 4 features on real Cloudflare (staging deploy done,
  browser test pending); Turnstile in a real browser; real email sending; the Apps
  Script on a real Google account; real CPU of Phase 4 endpoints and cron runs.
- After a restore, audit rows and outbox rows newer than the restore point are lost
  (the change log keeps the history); emails may be sent twice (harmless: every
  email links to the same ticket page).

## 10. What is left

1. Phase 4 live test on staging (owner, in a browser): site owner and organiser
   sign-in, party creation, party details, guest sign-up with Turnstile and a
   screenshot, approve, release, ticket page.
2. Load test on staging: 4,000 tickets admitted in 30 minutes across 10 parties x 4
   scanners, then a 5-minute burst at 8 scans/s; row estimate first, stop above 50%
   of the daily limits; report latency, errors, CPU, rows.
3. Owner setup: Gmail app password (and optional Brevo key) + an approved test
   email; backup key + Apps Script install + a restore drill from a real backup;
   Discord webhook secret.
4. Decision after the load test: a Vercel standby (manual switch-over if
   Cloudflare's daily limits run out mid-party) or not.
5. Production migrations, merge Phase 4.
6. Phase 5: frontend design (real pages; scanner requirements already written:
   contrast stretch and frame averaging, native BarcodeDetector; large QR on
   white with "turn brightness up"), and one real two-phone camera test.

## 11. Suggested audit questions

- Can any sequence of requests (including retries, lost responses, simultaneous
  phones, pauses and revocations) produce two successful redemptions of one ticket?
- Can an unauthenticated request write anything except the two documented
  exceptions?
- Is any security measure weaker than it should be (cookies, CSRF, Origin, Google
  token checks, HMAC formats, link tokens, backup signatures)?
- Does the recovery procedure bring back anything that was cancelled, reissued,
  revoked or used after the restore point?
- Are the free-plan limits (CPU, queries per request, daily rows and requests)
  respected with headroom at the expected peak?
