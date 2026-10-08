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
| 4 | Home page: party cards with the guest's own status; "Find my tickets" (needs backend) | next |
| 5 | Door scanner: camera, full-screen verdicts, sound and vibration | |
| 6 | Organiser dashboard: top numbers and big buttons | |
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

## Open questions for the owner

- Privacy and Terms drafts: approve or change the wording (then remove the
  "Draft" line). A contact for the site owner may be wanted on both pages.
- Nova logo: the site's favicon.svg has a dark navy dot (hard to see on the
  dark footer); the owner's image has a bright blue dot. Use as is, brighten
  the dot (owner's OK needed), or the owner supplies the PNG/SVG.
- Hero photos (idea 20) and the sign-in page look (idea 27): photos still to be
  handed over.

## Next

Piece 4, the home page. The original brief says "the website homepage is the
staff login"; the brainstorm (idea 4) agreed party cards as the hero with the
guest's own status on each card, and "Find my tickets". Ask the owner which
wins (or: party cards on "/" with a clear "Organiser sign-in" button). Needs
backend: a public list of open parties (name, date, flyer later) and a batched
status read for the remembered tickets; "Find my tickets" = one email with all
the address's ticket links across parties, rate limited, same answer either way.
