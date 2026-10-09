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
- "Too bland": the look follows Nova's site (https://bynova.vercel.app/):
  Space Grotesk headlines, Inter text, an Instrument Serif italic accent word,
  small monospace labels, a faint grid with corner marks, a frosted top bar,
  pill buttons, Nova blue as the one accent. Fonts are self-hosted
  (public/fonts, SIL OFL; `font-src 'self'` added to the page policy).
- Home layout: a hero that is a grid of party photos with a "Discover parties"
  button, then the parties as a grid of cards, then "About Sahra", then the
  footer; also good on phones.
- Home hero: full width, the photos in a grid behind the heading and buttons
  (not a grid beside the text).
- Logo and favicon (asked 2026-10-08): a crescent moon ("sahra" is a night out)
  with a Nova blue dot as its star, white on the dark base; the same family as
  Nova's white mark and blue dot. Files: public/img/sahra-mark.svg (top bar),
  public/favicon.svg, favicon.ico (16/32/48), apple-touch-icon.png (180).
- Animations and motion design (asked 2026-10-08): calm and purposeful. Pages
  rise in on load; hero photos arrive one by one, then drift slowly; the
  heading, text and buttons rise in after them; the accent word has a slow
  sheen; kicker dots pulse; home sections, party cards and steps fade up as
  they scroll into view; buttons lift on hover, the primary one gets a light
  sweep; card photos ease closer on hover; dashboard chart bars grow in on
  the first load only; the top bar gains a shadow once scrolled. The door
  verdict only gets a 0.12 s pop (never a delay). "Reduce motion" on the
  phone turns it all off, and without JavaScript nothing stays hidden.
- Second direction (owner brief, 2026-10-08, replaces the Nova-style look):
  no generic AI aesthetics, no pill buttons, no purple gradients, no vague
  hero text, no emoji icons, no em dashes, no fake reviews or counters, no
  cursor effects, no scroll animations. The owner's palette (charcoal #383635,
  grey #8A8786, light grey #C4C3C2, off-white #ECEBE9, near white #EFEEEC; its
  orange switched to a lighter white #FAFAF8); no colour accent, the solid
  charcoal fill is the one emphasis; green, red and amber only for meaning.
  Instrument Serif (Amiri for Arabic) headlines with tight tracking,
  JetBrains Mono (Plex Sans Arabic for Arabic) text on a strict 1.333 scale.
  Square corners, hairline rules, shadows only on what floats.
  North star (home): a guest sees how soon the next party is and how to get
  in, and trusts that the ticket is real. The number is the hero: days until
  the next party, beside a moon that waxes to match; three secondary real
  numbers; the parties as a printed programme. Dashboard: one primary number
  (approved of capacity, or inside of approved on the night) with a bar that
  fills to its share once, three secondary numbers. Motion: one staggered load
  reveal on the home hero; micro-interactions immediate (60 ms colour changes).
- Later the same day the owner rejected the second direction ("I dont like
  the font and the white color ... bring back the font and the original nova
  design"): the Nova-style look is back (dark base, Space Grotesk / Inter,
  photo-grid hero, Nova blue), without scroll animations, and with:
  - the owner's logo (a ticket with a starburst, wordmark "sahra" in Quicksand
    Bold as outlines, "Party tickets" removed) in the site colours: light
    ticket, Nova blue star. Files: img/sahra-logo.svg, img/sahra-mark.svg,
    favicon.svg/.ico, apple-touch-icon.png (generator kept in scratch: logo.mjs);
  - no gradients in the hero (flat tiles, a flat dark veil);
  - party cards after the owner's reference (an events row): a row that
    scrolls sideways with arrows, each card with the party's flyers on the
    start side as a small grid (one large, up to two small) and the details on
    the end side, aligned to the start (date | time, name, status dot with the
    price, Request a ticket). No flyers yet: a plain date tile, never stock
    photos. The flyer backend (upload, public read, list field `flyers`) is
    being built on branch claude/p5-flyers.
- Home cleanup (owner spec, 2026-10-08): no pills on the home page except the
  header controls and hero buttons; the hero keeps its collage with one flat
  veil, a solid blue "Discover parties" and an outlined "How it works", and no
  line under the buttons; cards with 12px corners and one border, details in
  the order date and time, name, price ("EGP 350" for one price, "From EGP 350"
  for several: the party list now also returns `price_count`, from the same
  subquery, no extra reads), availability, action ("Request a ticket", or
  "View details" when sold out or not open); arrows only when the row overflows
  (ResizeObserver); "How tickets work" as three plain columns with the owner's
  copy; the organiser sign-in row under one rule; 16px minimum text, 20px phone
  gutters, 44px tap targets, about 72px / 40px between sections.
- Hero photos: the owner has permission to use them; they are compressed
  (about 150 KB each) and slightly blurred before they go in public/img/hero.

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
| 4 | Home page: party cards with the guest's own status; sign-in page | done ("Find my tickets" across parties still to do) |
| 5 | Door scanner: camera, full-screen verdicts, sound and vibration | done (first version) |
| 6 | Organiser dashboard: top numbers and big buttons | done (first version) |
| 7 | Approval queue: one card per request, "Approve and send QR" | done |
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

- Piece 4: `GET /api/guest/parties` (dated, not switched off, not over;
  cached a minute in the isolate and the browser) and
  `POST /api/guest/tickets/status` (remembered links, one read). New
  `public/index.html` + `js/home.js` (hero, "Your tickets", party cards with
  date block, price from, state or the guest's own ticket status) and
  `public/signin.html` + `js/signin.js` (party team / organiser-or-site-owner,
  each "Continue with Google"; invitation only; door staff use their link).
  Top bar: Sahra at the start, language + Sign in at the end. Desktop rules
  (>= 900px) in sahra.css: wider main, 3-column cards, 4 tiles, columns.

- Desktop layouts: sign-up and ticket pages in two columns (`.cols`, the
  party / QR side sticky), dashboard buttons in rows and charts side by side,
  scanner in a centred column with a Back link (door staff to "/", owner and
  admin to the dashboard), Privacy and Terms in a narrow reading column. Fixed
  on the way: the sign-up page threw when a party had no rules (an empty
  section was appended).

- Nova-style redesign: sahra.css rewritten; home rebuilt (photo mosaic hero,
  Discover button to #parties, card grid with photo covers and date blocks,
  About Sahra with three steps and an organiser sign-in line); sign-in panel
  with a photo and a gradient; top bar frosted (`.topbar-shell`). Fixed on the
  way: an empty translation fell back to English (Arabic heading showed "for").

- Approval queue (`/queue.html`, piece 7): tabs Waiting / Approved / Rejected;
  one card per request (name, type, people, expected amount, duplicate-email
  warning, screenshot on tap, details with email, time and answers);
  "Approve and send QR" (approve, then release; if sending fails the card says
  "approved, QR not sent yet" and offers Send QR), "Approve only", "Reject"
  with an optional reason; Send QR on approved cards; select several (up to 20,
  the server's limit) for the same actions; Load more; CSV download; a link to
  the old queue tools. Answers marked `retry` (503) are retried with the same
  body. Checked locally end to end: each action, the bulk approve and send,
  and the QR emails queued in the outbox.

## Open questions for the owner

- Party cards as pages of a fixed grid (owner): 3 x 3 on desktops (party 1 2 3 /
  4 5 6 / 7 8 9, then the arrows turn to the next page), 2 x 3 on tablets,
  1 x 3 on phones; the page count shows between the arrows, which appear only
  when there is more than one page. Checked with 10 placeholder parties in the
  test browser: 9 + 1 on desktops, 6 + 4 on tablets, 3 + 3 + 3 + 1 on phones.
- Hero collage (owner): all photos the same size, edge to edge, in seven rows
  tilted 14 degrees that drift in opposite directions (CSS only, 70 to 84 s a
  loop; each row holds three copies and moves one, so the screen is always
  covered: measured 0% uncovered over the loop at 390 and 1440 px, English and
  Arabic); every other row is shifted half a photo so no grid lines run
  through. Still under "reduce motion".
- Headline (owner: "something more related to Sahra"): "Every great *sahra*
  starts here" / «كل سهرة حلوة تبدأ من هنا» (sahra means an evening out).
- Browser tabs after Nova's ("About | Nova"): "Page | Sahra" everywhere, the
  home page "Sahra | Private party tickets" (Sahra.title).
- About page (about.html, after Nova's About): "Ever searched TikTok for a
  party tonight?", true facts only (one scan per ticket, two languages, no app,
  QR by email), why Sahra, what organisers get, how hosting works, built by
  Nova, contact. Contact page (contact.html, after Nova's Contact): Nova's
  WhatsApp +20 111 999 0639, novadevco@icloud.com and @nova.dev26, and a form
  that stores nothing: it opens WhatsApp or the email app with the message
  filled in (js/contact.js). Nova's own form posts to formsubmit.co; doing the
  same would send visitors' details to that service and needs the page policy
  changed, so it waits for the owner's decision. Footer links: About, Contact,
  Privacy, Terms; the home page's organiser row has "Contact us" and "Sign in".
- Flat everywhere (owner: "remove the glossy buttons on all pages"): primary
  buttons are solid Nova blue with no gradient, inset highlight, glow or shine;
  cards, tiles, request cards, the sign-in panel and the page background are
  flat colours with no soft shadows; the unused blueprint grid is gone.
- Nova's site is now https://novadev.co/ (footer credit and About page).
- Hero photos: done. The owner uploaded seven photos (and a blank PNG, left
  out), then five more; all are resized to 1000 px at most, blurred a little,
  stripped of metadata (no location data) and saved as
  public/img/hero/hero-1.jpg ... hero-12.jpg (35 to 70 KB each). hero-3 is
  also the sign-in panel photo.
- Ticket waves (asked 2026-10-08): not built. Ticket types have their own
  sales windows and places, but one does not open when the previous sells
  out. Offered: up to 5 waves that open in turn.

## Next

Piece 8: party settings (details, ticket types, sign-up questions).
