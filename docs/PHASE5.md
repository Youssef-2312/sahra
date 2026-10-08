# Phase 5: the real screens (progress log)

Built in small pieces. After each piece: commit, push to `claude/p5-frontend`, and
update this file, so a new session can continue from the "Next" line without
re-reading the whole code base.

Branch: `claude/p5-frontend` (from `claude/p4-integration`). Staging deploys from
the `staging` branch; a finished piece the owner should try is pushed there too.

## Rules for every screen (owner decisions, docs/DECISIONS.md)

- Mobile first: one column, large tap targets, 16px+ text, the right keyboard
  per field, light pages. Desktop is a bonus.
- Clean and uncluttered: one main job and one obvious primary button per
  screen; extras behind "Details" / "More"; colour only for meaning
  (green = admitted/approve, red = used/rejected, amber = uncertain).
- No emojis anywhere. English by default with a small English / Arabic switch
  (remembered in the browser); Arabic is right-to-left. The organiser's own text
  (party name, description, rules, questions) is shown exactly as typed, never
  translated. Emails stay English.
- Fail closed on screen too: never show a QR that will not work; the scanner
  never shows green unless the server said "admit".
- Page security policy (public/_headers): scripts and styles only from the site
  itself, no inline style attributes (use classes), images may be data: URLs.
  No external fonts or libraries at run time; a library we need is copied into
  `public/vendor/` with its licence.
- No hosting-plan wording in anything guests or organisers see.
- Look (brainstorm ideas 24-28): dark charcoal base with ONE calm accent
  (periwinkle `#8ea2ff`), the same all year (nothing seasonal). Plain static
  HTML/CSS/JS only (no React, no build step); efferd blocks are inspiration only.
- Top bar: sign-in / account at the start, language switch at the end. Footer
  on every page: Privacy, Terms, copyright, and in the corner "Built by Nova"
  with Nova's logo (`public/img/nova-logo.svg`, a copy of
  https://bynova.vercel.app/favicon.svg) and an Instagram icon next to it
  linking to https://www.instagram.com/nova.dev26/ (Sahra has no Instagram).

## Owner decisions during Phase 5 (2026-10-08)

- Every page must also look good on a desktop (not only phones): wider layouts
  and columns on large screens, inspired by newform and efferd (dark, clean,
  rounded cards, generous spacing). Phones stay the first target.
- The home page lists all parties, with sign-in for organisers and staff at the
  top right. (This replaces the brief's "the homepage is the staff login".)
- The scanner needs a back button.
- Nova logo: the dot brightened to #2f6bff (owner's OK).
- Privacy and Terms: approved as written ("Draft" line removed).
- Production waits until the whole frontend is finished.
- Order: home page first, then the rest through the approval queue cards.

## Shared pieces

- `public/css/sahra.css`: the design (tokens, layout, buttons, forms, cards,
  status colours, light and dark).
- `public/js/i18n.js`: the English and Arabic wording, `Sahra.t(key, vars)`.
- `public/js/ui.js`: small helpers (`Sahra.el`, `Sahra.api`, money and time
  formatting, the language switch).
- The old bare test pages (`public/*.html` + `public/js/*.js` from Phases 1-4)
  stay until each is replaced; the replaced ones move to `public/test/`.

## Pieces

| # | Piece | Status |
|---|-------|--------|
| 1 | Foundation: stylesheet, wording (EN/AR), helpers, language switch | done |
| 2 | Guest sign-up page (`/signup.html?party=`): party, address status, ticket types, short form | done |
| 2b | Privacy and Terms pages (agreed, idea 28; text from what Sahra really stores; owner approves) | done (drafts) |
| 3 | Guest ticket page (`/ticket.html#t=`): big QR, name/type/group, party, address or countdown | done |
| 4 | Home page: party cards with the guest's own status; "Find my tickets" (needs backend) | waiting for the owner (brief vs idea 4) |
| 5 | Door scanner: camera, full-screen verdicts, sound and vibration | done (first version) |
| 6 | Organiser dashboard: top numbers and big buttons | done (first version) |
| 7 | Approval queue: one card per request, "Approve and send QR" | |
| 8 | Party settings: details, ticket types, sign-up questions | |
| 9 | Guests: find, resend, add a cash guest, CSV import (needs backend) | |
| 10 | Site-owner panel: needs attention, parties, organisers | |
| 11 | Backend items from the brainstorm (docs/IDEAS.md on claude/brainstorm): support phone, refund policy and tracking, request reference, manual admit, one-tap approve+send, find my tickets | |

## Done so far

- Piece 1: `public/css/sahra.css`, `public/js/i18n.js` (95 keys, English and
  Arabic; the Arabic wording should be read once by the owner),
  `public/js/ui.js` (`Sahra.boot({render})` adds the top bar and language
  switch; `render` runs again after a switch). Page skeleton:
  `<link rel="stylesheet" href="/css/sahra.css">` in head, `<main id="app">`,
  then `/js/i18n.js`, `/js/ui.js`, the page script.

- Piece 2: `GET /api/guest/parties/:party` now also returns `details` (the
  public party view). New `public/signup.html` + `public/js/signup.js`
  (replaced the test page; old version in git history). Organiser text uses
  `dir="auto"`. A language switch reloads the page (Turnstile widgets cannot
  move) keeping name/email/people in sessionStorage. Confirmed links are
  remembered in localStorage `sahra_tickets` ([{party, link, at}], newest
  first, max 20) for piece 4. "Lost your ticket link?" is a collapsed
  `<details>`; its bot check mounts when opened.
- Local check: `wrangler dev --env staging --persist-to <dir>` with a sample
  party, screenshots with Playwright (installed in the scratchpad, not the
  project) at 390x844, English and Arabic.

- Piece 2b: `public/privacy.html`, `public/terms.html` (both languages in the
  HTML, `public/js/doc.js` shows the chosen one), marked "Draft, to be approved
  by the site owner".

- Piece 3: `public/ticket.html` + `public/js/ticket.js`; QR drawn on a canvas
  with `public/vendor/qrcode-generator/` (MIT, level M, alphanumeric, quiet
  zone 4), shown as an <img> (also the "Save QR code" download). Checked: the
  drawn code decodes (jsQR) to exactly the code the server issued. The ticket
  API now returns `entry_from` (the type's entry time). The page remembers
  its link in `sahra_tickets`; it re-reads itself just after an address reveal
  time within the next day. No polling otherwise (requests budget).
- Local ticket check without the bot check: insert a ticket in the local
  database and sign its link with `src/guests/link.ts` bundled by esbuild
  (scratchpad `sign.mjs`), using the local `.dev.vars` keys.

- Piece 5: `public/scan.html` + `public/js/scan.js`. Camera via getUserMedia
  (back camera), QR via BarcodeDetector where the browser has it, else jsQR
  (`public/vendor/jsqr/`, Apache-2.0, loaded only then). Full-screen verdict:
  green ADMIT (name, type, group) goes back to the camera after 2.5 s; red
  ALREADY USED / DO NOT ADMIT and amber CAN'T VERIFY / PAUSED wait for "Next
  guest". Sounds (Web Audio) and vibration per result. One scan id per scan,
  reused for retries ("recording" or network), max 6 tries, then CAN'T VERIFY.
  The same code still in view is ignored for 4 s after its result. Light
  (torch) button where the phone supports it. No footer on this page. Door
  join (`/join`) now goes straight to `/scan.html`.
- Checked end to end locally (headless Chromium with a fake camera fed a Y4M
  video of a real ticket QR, scratchpad `scan-e2e.mjs`): join -> scanner ->
  ADMIT -> same code -> ALREADY USED, no page errors (jsQR path; headless
  Chromium has no BarcodeDetector). Real phones still to be tried by the owner
  (two-phone rehearsal).

- Piece 6: `public/dashboard.html` + `public/js/dashboard.js` + `public/js/charts.js`
  (inline SVG, no library). Tiles: approved of capacity, waiting requests,
  money expected (+ waiting), countdown or inside now. Buttons: Review (when
  any wait), open / pause the doors (pause asks first), scanner, guests, party
  settings, emails, team and tools (owner). Charts: arrivals per 15 minutes
  (once anyone is in), requests per day (14 days, party's time zone), tickets
  by type (donut + legend with numbers). Refreshes once a minute while
  visible. `GET /api/party/stats` gained money_expected, money_pending,
  pending_requests, requests_per_hour (30 days); arrivals are per 15 minutes.
  The old test dashboard moved to `public/tools.html` (`js/tools.js`): team
  invitations and the staging test tools, until a Team page exists.
- Local staff-page check: sign in as the local test party's owner by setting
  the cookie from a page on `http://localhost:8799` (`document.cookie`, Secure
  is allowed on localhost; CDP refuses it), scratchpad `as-owner.mjs`.

## Open questions for the owner

- Hero photos (idea 20) and the sign-in page look (idea 27): photos still to be
  handed over.

## Next

Piece 7 (approval queue cards, "Approve and send QR") unless the owner answers
piece 4 first.

Piece 4, the home page. The original brief says "the website homepage is the
staff login"; the brainstorm (idea 4) agreed party cards as the hero with the
guest's own status on each card, and "Find my tickets". Ask the owner which
wins (or: party cards on "/" with a clear "Organiser sign-in" button). Needs
backend: a public list of open parties (name, date, flyer later) and a batched
status read for the remembered tickets; "Find my tickets" = one email with all
the address's ticket links across parties, rate limited, same answer either way.
