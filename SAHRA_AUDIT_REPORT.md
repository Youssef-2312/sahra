# Sahra production audit report

Date: 9 to 10 October 2026 (UTC). Read-only on production: no forms were submitted,
no one signed in, no email was sent and no real records were created there.
Workflows that need a party or a signed-in person were tested on a local copy
(production has no parties yet, and sign-in is the owner's Google account).

## Production status

| | |
|---|---|
| Production URL | https://sahra.bynova.workers.dev |
| Repository / branch | `Youssef-2312/sahra`, `main` (deploys automatically on merge) |
| Baseline before the audit | `3d52b8460d6f6a25ec44575904681b7a58e24a24` (merge of PR #8) |
| Deployed fix | `0d7aac2d7823db991e62005c12665946f37cf2ba` (merge of PR #9) |
| Deployment | Live 45 s after the merge (2026-10-09T22:56:42Z): production serves the stylesheet from that commit (`--accent-2: #2f68ff`) |
| Post-deploy verification | Passed: 66 page loads, 0 page errors, 0 overflow, no unexpected failed requests, axe no serious/critical findings, API answers and security headers as expected |

## Issues found and repaired

| ID | Severity | Location | Symptom and evidence | Root cause | Fix | Test | Status |
|---|---|---|---|---|---|---|---|
| A-1 | Minor (accessibility, WCAG AA) | Every primary button, every page | axe (production, 390 and 1440 px): "insufficient color contrast of 4.49 (#ffffff on #2f6bff)", 19 elements across `/`, `/about`, `/contact`, sign-in result pages | The button blue was a hair too light for white text (4.499:1; AA needs 4.5:1) | `public/css/sahra.css`: `--accent-2` `#2f6bff` to `#2f68ff` (4.62:1; 3 steps in one channel, visually the same). Logos keep their colour (decorative, no text) | `test/contrast.test.ts` (fails on the old value, passes on the new); axe on the local copy and on production after the deploy: no findings | Deployed, verified |
| A-2 | Test gap | Door scanner (browser) | The old scratch scanner check no longer matched the rebuilt join page | Script out of date | New `scripts/scan-browser.mjs`: own door invitation and fresh ticket, the ticket page's real QR as fake camera video, join, scan | Passes: verdicts `admit`, then `used` (admitted exactly once) | Deployed (script only) |

## Test coverage

- Type check (`tsc --noEmit`): clean.
- Unit and integration tests (`vitest`): 42 files, 521 tests, all passed.
- Dependency audit (`npm audit`, all and production only): 0 vulnerabilities.
- Production browser audit (Playwright, read-only): 22 addresses (home, About,
  Contact, Privacy, Terms, Find my tickets, sign-in, My parties, sign-up and ticket
  with bad or missing links, door join, scanner, the six staff pages signed out,
  a 404, a sign-in result page) at 375, 390, 768, 1024, 1440 and 1920 px in English
  and 390 and 1440 px in Arabic: 176 page loads, 0 page errors, 0 horizontal
  overflow, 0 broken images, 0 images without alt text, 0 clipped text.
  Console "errors" seen are the pages' own expected answers (401 for signed-out
  checks, 404 for unknown links and the 404 page, 400 for the cancelled sign-in),
  the Turnstile calls the read-only test blocks, and a headless-browser WebGPU
  warning.
- Accessibility (axe, serious and critical): only A-1, now fixed.
- Local workflow checks (browser): party settings, guests (issue, search, resend,
  new QR, change email, transfer, cancel), Emails page, team and door invitations,
  door join (link works once), manual admit at the door, ticket reference, cancel a
  party and refunds, CSV cash import, Find my tickets, Requests queue, contact form,
  email change notice, organiser and site-owner panel (`scripts/platform-browser.mjs`,
  18 role/language/width combinations), the page sweep (16 pages, 3 widths, 2
  languages: 90 checks, 0 problems) and the camera scanner (A-2). All passed.
- Security review of the server code: every state-changing route is protected
  (staff/platform session with Origin and CSRF checks; the backup routes by HMAC
  signature; public guest routes by Origin check, rate limits and Turnstile; the
  scanner fails closed with "not signed in"). All SQL is parameterised (the one
  table name built into a statement comes from a fixed map). Guests' ID photos and
  payment screenshots are limited to the party's owners and admins inside the SQL.
  Logs hold counts, not addresses or secrets. The new "Open" route for My parties
  requires the live My parties session and the account's own owner/admin row inside
  the insert. A QR is admitted once (unit tests and A-2). Nothing reproducible found.
- Performance: not measured in detail in this audit (no page-weight or timing
  profile was recorded). Pages are static files plus small API calls with
  self-hosted fonts; every page in the audit runs loaded within the test's limits.

## Unresolved issues

None that block production. Not testable from here, and why:

- Real sign-in with Google on production and real email delivery: these need the
  owner's Google account and the email settings (the owner sets the Gmail or Brevo
  secrets; until then no ticket emails go out).
- Ticketing workflows on production itself: production has no parties yet; they
  were tested end to end on a local copy instead.

## Recommendations

1. Set the email accounts (`email-accounts.bat`, or the Brevo secrets), then issue a
   ticket to yourself and check it shows as sent on the Emails page.
2. Run `backupNow` once in the production Apps Script and check a
   `sahra-backup-...` folder appears in Drive.
3. Before the first real party, a two-phone rehearsal at the door with real QR codes.

## Follow-up: 10 October 2026, picture questions and quality of life

The earlier production snapshot above is historical. Production now has a party.
Public read-only diagnosis found guest requests closed by an expired closing date:
`1761339600000`, 25 October 2025 at 00:00 Africa/Cairo. Opening QR admission does
not override this guest request window. Overview now explains the distinction and
links to Settings > Requests. No production party settings were changed.

The current local audit passes 534 tests across 44 files and the typecheck.
English/Arabic browser checks at 390, 768 and 1440 px pass 54 staff layouts,
18 platform-role layouts, 30 public layouts, 66 guest layouts, six complete
stubbed guest flows, six quality-of-life flows and six contact layouts. Each
reports zero horizontal overflow and no unexpected console/page errors.
The camera scanner returned `admit`, then `used`, for the same QR.

Picture questions are tested for private owner/admin viewing, door/other-party
refusal, required uploads, invalid type and oversize refusal, missing storage,
idempotent retries, backup downloads, seven-day retention, orphan cleanup and
an edit racing the guest upload. Full details and measurements are in the new
entry in `docs/PHASE5.md`; decorative photo references are in
`docs/PHOTO-SOURCES.md`. Photo collage checks passed 96 animation samples with
no repeated visible tile (intersection greater than 40 px on each axis).

Real Google sign-in, email delivery, physical phone cameras and a backup running
in the owner's Google account remain outside the local checks. No real email was
sent, and no production guest data was created or changed.

The full local backup/restore drill passed: nightly and hourly, two file stores,
five changes replayed with zero holds, corrupt-file refusal, daily-budget
behaviour, three older backup folders permanently deleted after guest erasure,
and one simulated wrong-key alert. The synchronous Apps Script simulation now
runs off the Miniflare host event loop, with correlated HTTP responses. No Google
account or real alert email was used. Full dependency audit: zero vulnerabilities.

PR #14 merged as `b76e45acbde2fb59b72b323a6a071929a2f35c24`, and Workers Builds
completed successfully. At 20:35:09 UTC, production served the new home script;
ten additional release files (CSS, shared UI, settings, sign-up and six photos)
matched byte-for-byte. The post-release read-only browser sweep passed 102 layouts
(17 addresses, both languages, three widths), with zero overflow, broken images
or unexpected errors. Expected signed-out and invalid-link 401/404 responses were
kept separate. A signed-out picture request returned 401, no-store and nosniff.
No production form was submitted or record changed.
