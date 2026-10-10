# Phase 5: the real screens (progress log)

Built in small pieces. After each piece: commit, push to `claude/p5-frontend`, and
update this file, so a new session can continue from the "Next" line without
re-reading the whole code base.

Branch: `claude/p5-frontend` (from `claude/p4-integration`). Staging deploys from
the `staging` branch; push there only after the owner explicitly approves, because it auto-deploys.

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
  linking to https://www.instagram.com/novadev.co/ (Sahra has no Instagram).

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
| 8 | Party settings: details, ticket types, sign-up questions | done |
| 9 | Guests: find, resend, issue tickets, message guests | done; CSV import still needs backend |
| 10 | Site-owner panel: needs attention, parties, organisers | done |
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
  WhatsApp +20 111 999 0639, novadevco@icloud.com and @novadev.co, and a form
  that stores nothing: it opens WhatsApp or the email app with the message
  filled in (js/contact.js). Owner decision: keep FormSubmit; the form is
  emailed through Nova's FormSubmit endpoint after a consent box, and only
  /contact may connect to formsubmit.co (public/_headers). Footer links: About, Contact,
  Privacy, Terms; the home page's organiser row has "Contact us" and "Sign in".
- Flat everywhere (owner: "remove the glossy buttons on all pages"): primary
  buttons are solid Nova blue with no gradient, inset highlight, glow or shine;
  cards, tiles, request cards, the sign-in panel and the page background are
  flat colours with no soft shadows; the unused blueprint grid is gone.
- Nova's site link (footer credit and About page): https://bynova.vercel.app/ (owner); Instagram stays @novadev.co.
- Home refinement (owner spec): headline "A great *sahra* starts here.";
  one container for the parties, steps, organiser row, footer and header
  (1120 px content, 24 px desktop / 20 px phone gutters); 40 px hero to
  "Upcoming parties", 20 px to the cards, 40 px to "How tickets work", 32 px to
  the organiser row, 40 px to the footer. Cards: the party's own first image on
  top at 16:9 (cover), or a compact text-only card; 3 equal columns on
  desktops, 2 on tablets, 1 on phones; 20 px padding, 12 px corners, one
  border; titles 21 px / 1.25, three lines at most (the full name on the
  party page and in the title attribute); actions aligned at the bottom.
  Steps: 24 px heading, 17 px titles, 16 px / 1.5 text. Footer links 44 px tall.
- Guest wording: "Purchase a ticket" (card), "Purchase ticket" (sign-up
  button), "Purchase your ticket" (step 1) instead of "Request". Status lines
  still say the organiser checks the request, because approval is still a step.
- Flyers (owner): organisers may upload more than four pictures per party
  (suggested cap 8) when the flyer upload is built; cards show the first, the
  party page shows them all.
- Party pictures backend (migration 0016_party_flyers.sql, src/party/flyers.ts):
  up to 8 per party (owner: more than four). Owner/admin: GET /api/party/flyers,
  POST /api/party/flyers (multipart `file` + `op`; JPEG/PNG/WebP from the first
  bytes, 600,000 bytes at most; a retry with the same op is the same picture;
  the limit is counted inside the INSERT, so racing uploads never make a ninth),
  POST /api/party/flyers/:id/delete. Guests: GET /api/guest/flyers/:party/:id
  (live pictures of parties switched on and not over; one-year immutable cache,
  the URL carries the picture's rev; a few MB kept in the isolate). The party
  list and the party page carry `flyers: [{ id, url }]`. Bytes live in the
  files databases like screenshots; the daily purge keeps live pictures and
  empties deleted ones, those of parties over for 30 days, and failed uploads
  after a day. Logged entity (change log, audit, recovery, backup export);
  daily limit 50 uploads per party. Tests: test/flyers.test.ts. The owner
  applies migration 0016 on staging first, then production.
- Hero photos: done. The owner uploaded seven photos (and a blank PNG, left
  out), then five more; all are resized to 1000 px at most, blurred a little,
  stripped of metadata (no location data) and saved as
  public/img/hero/hero-1.jpg ... hero-12.jpg (35 to 70 KB each). hero-3 is
  also the sign-in panel photo.
- Ticket waves (asked 2026-10-08): not built. Ticket types have their own
  sales windows and places, but one does not open when the previous sells
  out. Offered: up to 5 waves that open in turn.
- Privacy and Terms (owner spec, after Nova's privacy page): 680 px reading
  column, title 30/26 px, section headings 17 px semibold, body 16 px / 1.6,
  10 px under headings, 28 px between sections, 8 px between bullets, fixed
  "Last updated: 9 October 2026". Terms are the owner's text with one change:
  party pages show no refund or cancellation policy, so guests are told to ask
  the organiser instead of to "check" one.
- Signed in on public pages (owner: "keep the sign in session even if I press
  home"): the session always stayed; the header just said "Sign in". Staff
  pages that confirm a session now note its kind ("party" or "platform",
  nothing else) in the browser, and public pages then show the signed-in name
  linking back to the dashboard, scanner or platform page. Guests make no
  extra request.
- Terms acceptance on the ticket request form (migration 0017,
  src/guests/policy.ts): above the button, a privacy notice ("Sahra and this
  party's organiser use your details ...", the email sentence only when an
  email provider is configured) linking the Privacy page, and a required,
  unticked box "I agree to Sahra's Terms" plus "and this party's entry rules"
  when the party has rules (linking the rules shown on the page). Links open in
  a new tab; the box is never remembered. The server refuses a request without
  the box (400 terms_not_accepted) and one whose form showed other versions
  (409 terms_changed, with the current versions and rules; the form keeps what
  was typed). The ticket row stores terms_version, rules_version (hash of the
  rules text), privacy_version and terms_accepted_at, all chosen by the
  server, in the same INSERT, which also requires the rules text to be
  unchanged. Retries are the same row. Older requests and staff-issued tickets
  stay NULL (unknown). No IP address is stored for it; it is not a marketing
  opt-in. Tests: test/terms.test.ts.
- One sign-in button (owner: "merge them together"): "Continue with Google"
  checks the account's party-team access and its organiser / site-owner access
  in the same callback. Platform access only: the platform page. Party access
  only: the dashboard (or the party choice). Both: a platform session plus the
  party choice with an "Organiser page" link. The platform page keeps its own
  button. Roles: the site owner invites organisers; an organiser creates
  parties and becomes each one's owner; a party's owner invites admins and
  door staff.
- One site owner (owner decision): only youssefwaelkabbeel@gmail.com
  (SITE_OWNER_EMAIL, src/platform/db.ts) gets site-owner rights, checked inside
  every statement that grants them (sessions, sign-in links, actions, health
  alert recipients); scripts/site-owner-sql.mjs refuses other addresses.
- Cancellation policy (migration 0018, owner: "make them agree to the
  cancellation rules as well"): parties.cancellation_policy, written by the
  owner/admin next to the entry rules, shown on the party page and the ticket
  page. The Terms box names whichever the party has ("entry rules and
  cancellation policy"); the accepted rules_version is a hash of both texts.
  A party without either shows "I agree to Sahra's Terms" only.
- Instagram: @novadev.co everywhere.
- Guest details deleted 7 days after the party (owner decision; migration 0019,
  src/guests/retention.ts, daily health run): guest name, email, answers and
  rejection reason on every ticket of a party over by 7 days, the same fields
  in every change-log copy (so recovery still matches), rejection reasons in
  the audit log, and the party's email texts (unsent ones cancelled). Ticket
  rows stay without names (status, people, type, price, check-in time, accepted
  Terms). Payment screenshots: 7 days after the party (was 30), or 30 days
  after a rejection or cancellation. Party pictures stay at 30 days. Tests:
  test/retention.test.ts.

- Backups follow the same 7 days (owner decision): `/api/backup/schedule` returns
  `guests_erased_at` (latest finished guest deletion). The Apps Script then makes a
  fresh full backup at once and, after it succeeds, deletes every older backup
  folder; screenshots Sahra deleted are removed from Drive and noted in
  `screenshots/index.json` ("removed"), which the restore treats as deleted, not
  missing. Deletions are permanent (Drive advanced service, not the trash).
  Checked by `node scripts/backup-e2e.mjs` (all steps OK, local simulation only).

- ID photos and Instagram handles (owner request; migration 0020): a party's form
  can ask for each ("none" default, "optional", "required"; checked by the server).
  The handle is reduced to Instagram's form (a pasted link or "@" is fine); the ID
  photo is stored like the screenshot (owner "idphoto:<ticket>"), opened only by
  owners and admins (GET /api/tickets/:id/id-photo, never door staff), and deleted
  7 days after the party, a rejection or a cancellation. The handle goes with the
  other guest details at 7 days (tickets and change log). The inline notice then
  says the ID is checked (privacy version "+id"). Queue: "Show ID photo" and the
  handle as a link; CSV exports include it. Tests: test/idphoto.test.ts.

- Group and single tickets (owner request; migration 0021): a ticket type sets
  min_people / max_people (NULL = 1 to the party's max_people_per_ticket), e.g.
  "Normal" 1 to 1 and "Group" 2 to 6; checked in the request and issue
  statements (src/guests/types.ts peopleOk). The ticket page's Quantity follows
  the chosen type (hidden for exactly one person); each type says how many people
  it admits. Party page: people-per-ticket fields and Normal / Group presets, and a
  Guest form section for proof of payment, ID photo and Instagram. Tests:
  test/grouptypes.test.ts.
- Separate tickets in one request (owner request; migration 0022): a guest can
  ask for up to 10 tickets at once (never more than the party's tickets per
  email), one per friend, each with its own link and QR code so friends can
  arrive separately. Friends' names are optional (an empty one takes the
  buyer's). One INSERT creates all or none; the whole order counts against
  capacity, type places and the per-email limit. The tickets share order_id
  (the first ticket's id); the payment proof, ID photo, Instagram and answers
  stay on the first. The queue shows an order as one card ("3 tickets") and
  approves, sends or rejects all of them together. Tests: test/orders.test.ts.
- Dashboard redesign, Quantity selector, Nova-style footer, wording pass ("Time",
  "Location", a professional tone), home tab "Sahra | Parties".

## Staff pages redesign (2026-10-09)

- Shared staff layout and bilingual wording now cover Overview, Requests,
  Settings, Guests, Emails and Team. Settings saves each section separately;
  Guests includes ticket help and issuing; Emails includes approval and
  cancellation; Team includes Google invitations and one-time door links.
- Join uses the shared shell. Browser-tested against local D1 in English and
  Arabic using invitations created on Team: joining creates a door session and
  opens the scanner; opening a used link in another browser shows the used-link
  message. That message now changes language when the language switch is used.
- Rebuilt `platform.html` / `js/platform.js` with the shared dark styles, named
  lists and contextual forms. **Health and administration are site-owner only**:
  the backend still restricts that role to `youssefwaelkabbeel@gmail.com`.
  Organisers see only their own parties and the create-party form. Their browser
  makes no health request; the local API also rejects organiser health access
  with 403. No server authorization rules were changed.
- The site-owner view includes the six health checks, status pills, daily usage,
  Discord delivery status, recent alerts and per-party counters; organiser
  invitations, disabling and party limits; counts-only party lists, disable /
  enable / manage, replacement-owner invitations; and the site-owner list.
  Health labels and explanations are bilingual. Original server-authored
  diagnostic reports and alert subjects remain verbatim, behind labelled details
  where appropriate, so specific failure information is retained.
- Platform sign-in and CSRF remain separate from party staff sign-in. Existing
  disable-organiser, disable-party and remove-site-owner confirmation dialogs
  are retained. Complete request bodies and generated invitation / staff UUIDs
  survive automatic and manual pending retries; forms lock while the outcome is
  uncertain. The create-party address pattern works with modern browser
  validation. No ID text boxes are needed to target existing people or parties.

Validation:

- Local Worker / D1 browser checks passed for organiser invitation, party-limit
  change, organiser disable (including cancelling confirmation), party creation,
  disable and re-enable (admission stays paused), manage-party navigation with a
  real owner session, and replacement-owner invitation. All data and keys were
  synthetic and local; no email provider or real account action was used.
- Chromium: **54 page / language / width combinations**, covering Overview,
  Requests, Guests, Settings, Emails, Team, Join, Scanner and the site-owner
  panel at **390, 768 and 1440 px**, in **English and Arabic**. Every result:
  `document.documentElement.scrollWidth - innerWidth === 0`, with **zero console
  errors**. Populated local records and expanded secondary sections were checked.
  A stopped local Wrangler process interrupted the first attempt; the complete
  matrix was rerun successfully after restart.
- `scripts/platform-browser.mjs` adds repeatable browser regression checks with
  intercepted API fixtures: **18 role / language / width combinations** (site
  owner, organiser, signed out), role separation, platform CSRF, pending retries
  with identical bodies and UUIDs across a language switch, party disable /
  enable, owner invitation and site-owner removal confirmations. It refuses
  non-local origins. Run with local Wrangler and an external Playwright install
  as documented at the top of the script; project dependencies are unchanged.
- Staff dictionaries have **548 English and 548 Arabic keys**, with matching key
  sets. `npx tsc --noEmit -p .` passed; `npx vitest run` passed **488 tests
  in 33 files**.

## Next

- Owner review on staging after explicit approval to push `staging`; no staging
  push or production deployment was performed for this change.
- If not already applied, the owner applies migrations **0020, 0021 and 0022**
  on staging: pull `claude/p5-frontend`, then run
  `npx wrangler d1 migrations apply sahra-staging --remote --env staging`.
  This frontend change adds no migrations.
- Real-phone scanner / two-phone rehearsal and optional ticket-page polish.
  Scanner verdict logic was not changed.
- Known gaps: ID photos are collected from the buyer only, not friends on a
  multi-ticket order; Drive backup is not active; Find my tickets is not built.

### Contact redesign and shared visual polish (9 October 2026)

The contact page now uses a larger bilingual headline, an existing Sahra party
photo and a full-width ruled message panel alongside a consistently padded form.
The Send button fills the form's content box, removing the desktop width plus
margin overflow. Name, email, phone, date and guest controls share 52px height,
16px type, 10px corners, 12px by 14px padding and the same dark fill and border.
The date is optional free text with English/Arabic examples; the message field
has five rows and a 146px minimum height. Consent uses a dark, blue checked box.
Date help and the simplified footnote are 14px. FormSubmit, consent meaning,
Privacy, honeypot and WhatsApp/email alternatives remain in place. Invalid email
focus now lands on the email field; submit routing uses the current submitter.

Shared polish adds bilingual Parties/About/Contact navigation with an active
underline, larger home/About and staff headings, clearer statistics and ruled
staff lists. The scanner keeps its compact header. Dark Nova colours, existing
photography and solid surfaces remain; no gradients or inline scripts/styles
were introduced. Legal copy, backend permissions and admission logic are unchanged.

Browser validation used local Wrangler and Chromium at 390, 768 and 1440px in
English and Arabic. All six contact layouts measured zero horizontal overflow
and zero console errors. Send button insets from both card edges were 21px on
phone/tablet and 29px on desktop, including the 1px card border. Desktop column
tops matched exactly (0px difference). All five single-line controls measured
52px; textarea 146px; all six shared computed border, background, radius, font
size and padding. Message links measured 83.05 to 88.69px high.

`scripts/contact-browser.mjs` reproduces the contact checks with optional external
Playwright, rejects nonlocal origins and intercepts every FormSubmit request.
Twelve stubbed submissions covered rejection with preserved input and success
with reset across the six layouts. Missing consent and filled honeypot blocked
submission; WhatsApp URL construction was checked with window.open stubbed.
No real email was sent. Screenshots and JSON measurements are written outside
the repository (set SAHRA_SCREENSHOTS to choose a directory).

The shared styling was also checked across 54 staff layouts (dashboard, queue,
guests, party, outbox, tools, join, scan and platform) and 30 public layouts
(home, About, sign-in, Privacy and Terms), all with zero horizontal overflow and
zero console errors. Screenshots use synthetic local data, not live accounts.

Required pre-commit checks passed: `npx tsc --noEmit -p .` and `npx vitest run`
(33 files, 488 tests). No deployment or remote account action was performed.

### Homepage expansion (9 October 2026)

Added all three areas requested by the owner: an editorial photo section using
three existing approved images, a guest preparation guide and a hosting guide.
Guest guidance explains request versus ticket release, checking time/rules and
address availability, and keeping a released QR private. Hosting guidance covers
ticket setup, reviewing requests and payment proof, and inviting the door team.
The existing hero, real party listings, ticket steps, FAQ and contact actions stay
in place. New content is translated into English and Arabic, with logical layout
properties for RTL, solid dark surfaces and the existing blue accent.

Local Chromium checks passed at 390, 768 and 1440px in both languages: six layouts,
zero horizontal overflow, zero console errors, all three gallery images loaded,
three guest tips and three hosting tips rendered in every layout. The gallery's
party link and the language switch worked. Public translation keys match at 385
per language. Full-page screenshots were captured outside the repository.

Pre-commit typecheck passed and all 488 tests in 33 files passed. The owner
explicitly authorised deploying this frontend update to staging; production
and database migrations are excluded.

### Find my tickets (9 October 2026)

Brainstorm idea 4 (owner decision "the middle"): on a device that does not
remember a guest's tickets, `/find` takes an email and sends ONE email with the
links to every live ticket of that address across parties (pending, approved or
rejected; not cancelled; parties not disabled and not over by more than a day;
soonest first, at most 20). No accounts.

- `POST /api/guest/find` (`src/routes/guests.ts`): same origin, Turnstile, rate
  limits per IP and per address, and a site-wide daily cap (`find_tickets`, 500,
  counted under the reserved `_platform` row whether or not anything is sent).
  The answer is the same whether or not the address has tickets. At most one
  email per address per hour (the outbox id is derived from the address and the
  hour). `GET /api/guest/find` gives the page its Turnstile site key.
- The lookup reads the small parties table and each party's existing
  `(party_id, guest_email)` index; no migration.
- The email is Sahra's own plain text (party name, date in the party's time
  zone, link), filed under the soonest party so it is erased with that party's
  guest details 7 days after it.
- Linked from every page footer (Site column), from "Your tickets" on the home
  page, and from the ticket page's device note.
- Tests: `test/find.test.ts` (4), plus the unauthenticated-route and page-header
  tests. Browser: 390 and 1440 px, English and Arabic, zero overflow and errors.

### Organiser contact number (9 October 2026)

Brainstorm idea 16 (owner: "A phone or WhatsApp number. required"). Migration
**0023** adds `parties.support_phone`, `support_email` and `support_note`.

- Settings has a "Contact for guests" card (phone required, email and "when you
  answer" optional; the hint says the number is public). The dashboard shows a
  warning with a link while no number is set.
- Guest requests stay closed until a number is set: checked in the sign-up
  INSERT itself (`registrationRules.opened`), shown as "not open yet" on the home
  card and the ticket page ("the organiser has not added a contact number").
  Existing tickets are not affected; clearing the number closes new requests.
- Shown on the ticket request page and the guest's ticket page (Call; WhatsApp
  for a number in +country form; Email), with "Sahra does not run parties", and
  on the door scanner ("Organiser: number") for staff.
- Format: digits, spaces and + - ( ), 6 to 20 digits (`cleanPhone`).
- Tests: `test/support.test.ts`; test parties now carry a number.
- **Owner action:** apply migration 0023 on staging, then add a contact number to
  each staging party in Settings (or rerun the demo script, which sets a fake
  demo number). Until then their ticket requests are closed.

### Find guest and manual admit at the door (9 October 2026)

Brainstorm idea 8. For a guest whose QR will not scan, the scanner has "Find
guest": search by name (or ticket id), see each match's state (can enter, already
inside with when and by whom, not approved, QR not sent, on hold, rejected,
cancelled), and "Admit by hand" for one that can enter, after a confirmation.

- `POST /api/scan/manual` goes through the SAME redemption as a scan
  (`admission()` in `src/routes/scan.ts`, shared with `POST /api/scan`): the
  control object must be open, the guarded UPDATE marks the ticket used only once,
  the ledger admission record must be confirmed, and the control object is read
  again. Paused is amber, an unconfirmed ledger write is amber ("recording", the
  retry with the same scan id finishes it), anything else is red. A manual admit
  after a scan, a scan after a manual admit, and two phones at once all admit the
  ticket once (tests).
- Recorded as manual: an `admitted_manually` audit row with the staff member, in
  the redemption batch (only when that batch admitted the ticket). Migration
  **0024** adds a partial index for the organiser's review list
  (`GET /api/scan/manual`, owners and admins), shown on the Guests page as "Let in
  by hand".
- `GET /api/scan/find` (any door role): at most 10 matches, the email masked
  ("m***@example.com"), the session checked in the statement, rate limited with
  the scanner.
- The QR scan path itself is unchanged in behaviour (its 25 tests pass); the
  green screen says "Admitted by hand" for a manual admit.
- Tests: `test/manual-admit.test.ts` (4), plus the unauthenticated-route list.

### Request reference and review time (9 October 2026)

Brainstorm idea 15 (first part). Every request has a short reference, "SAH-" and
the first 6 characters of the ticket id (`src/guests/reference.ts`), shown after
asking (one per ticket of an order), on the guest's ticket page, on request cards
and in staff search, which also finds a request by it ("SAH-K7Q9XM", any case,
with or without the dash; party-scoped). It identifies; it never opens a ticket.
Migration **0025** adds `parties.review_time` ("Usually within 24 hours"), set in
Settings > Requests and shown after asking and on a waiting ticket's page.
Tests: `test/reference.test.ts`.

Not built from idea 15: the "edit email" action with a notice to the old address
(the existing name transfer already changes the email and replaces the link).

### Cancel a party and track refunds (9 October 2026)

Brainstorm idea 14. Migration **0026**: `parties.cancelled_at`, `cancel_reason`,
and a separate `refunds` table (due / done, amount = price x people), kept apart
from tickets so the door's records never change. Settings has "Cancel the party"
(owners; typed party name to confirm; cannot be undone): admission pauses first
and can never reopen, requests close, paid waiting/approved tickets can be marked
"refund due", and a notice to every guest waits in Emails for approval. Guests >
Refunds lists due and done with totals; owners and admins tick "refunded"
(audited). Guest pages say the party was cancelled, hide the QR, and show the
refund state. Refunds are in the backup. Tests: `test/cancel.test.ts`.
Checked in the browser at 390 px (cancel, refunds list, guest ticket page, admission refused to reopen); the refund totals were made smaller afterwards so "EGP 450" does not wrap on a phone (not yet re-checked in the browser).

### Cash guests: one by one or from a CSV file (9 October 2026)

Brainstorm ideas 9 and 17. Migration **0027** adds `tickets.payment` ('cash').
- Guests > Issue a ticket: Payment "Paid in cash" (keeps the type's price) or
  "Complimentary". `POST /api/tickets/issue` takes `cash: true`.
- Guests > Import cash guests: a CSV (name, email, ticket type, people; template
  to download; commas or semicolons; Excel's BOM handled) is read in the browser;
  the preview flags a missing name, a bad email, a duplicate email, an unknown
  ticket type, more than the tickets per email, and rows over the places left;
  the summary says "Add N guests, paid in cash, and send their QR codes", with
  "Send QRs now" (default) or "Add only, send later"; nothing is created before
  Confirm. `POST /api/tickets/import` takes 5 rows per request (about 5 queries
  per row), each through the same guarded INSERT as a staff-issued ticket
  (capacity, type places, people per ticket, and the tickets-per-email limit for
  cash), ids from the file's op and row index so a retry creates nobody twice.
- The dashboard's money tile shows the cash part; the CSV download has "paid by";
  Requests has a "Cash only" filter (`GET /api/tickets?payment=cash`) and cash
  cards say "Paid in cash".
- Tests: `test/cash.test.ts`. Browser: 390 px, a 6-row file with 4 problem rows.

### Change a guest's email, with a notice to the old address (9 October 2026)

Brainstorm idea 15 (the rest). Guests > a guest > "Change email": a transfer
with the same name. The old link and QR stop working, the new link goes to the
new address, and the OLD address gets a notice in the same batch ("moved to
another email", the organiser's contact, quote your reference), without the new
address. A name-only transfer or the same address sends no notice. Tests:
`test/email-change.test.ts`.

### Disabling a party from the site-owner panel (9 October 2026)

Brainstorm idea 19: "Disable party..." opens a panel with the effect in numbers
(requests stop, admission pauses with the approved tickets affected, staff
sessions and invitations end); the button works only once the party's name is
typed. "Enable party" is one confirmed action. `scripts/platform-browser.mjs`
covers it.

All agreed brainstorm ideas (1 to 19, 21, 22, 24 to 28) are now built. Open ones:
20 (look and feel words to confirm) and 23 (logo and favicon, decided later).

### Friends' ID photos and a larger favicon (9 October 2026)

Closes the known gap above. When the party asks for an ID photo, each friend's
ticket on an order gets its own upload ("ID photo for ticket 2", ...), sent as
`id_photo_1`..`id_photo_9` and stored on that friend's ticket, so the usual
7-day purge (src/storage/) covers it. "Required" refuses an order with a
missing friend photo and names the ticket ("Please add the ID photo for ticket
3."); a photo for a ticket beyond the order, or any photo when the party asks
for none, is refused. The signup body limit grows to fit one photo per ticket.
Requests: a grouped card shows an ID button per person who has a photo.
Test: `test/idphoto.test.ts` (friends case).

Favicon: the same ticket mark, scaled up (0.2 to 0.25) so it fills a browser
tab; favicon.ico (16/32/48) and apple-touch-icon.png (180) regenerated from it.

### Sign-in results, page not found and broken links in the site's look (9 October 2026)

Before, the server's own pages were bare HTML (sign-in failed, no access, choose a
party) and a mistyped address answered `{"error":"not_found"}`. Now:

- `src/auth/notices.ts` + `page()` in `src/lib/http.ts`: every page the Worker
  answers itself uses the shared stylesheet and `public/js/notice.js`, which shows
  it in English or Arabic with the top bar and footer: a photo panel with the
  message, the ways forward beside it (back to sign in, the parties, Find my
  tickets), Google's reason code small when there is one. Status codes and cookies
  are unchanged; the English text stays in the HTML (shown before the script runs).
- The sign-in buttons' form posts (wrong origin, too many attempts) and the party
  choice answer pages, not JSON. The party choice shows each party with its role.
- A page address that is not a file answers an HTML 404 ("Page not found");
  `/api/...` and non-GET requests keep JSON.
- The Worker's security policy gains `font-src 'self'` (the same as the static
  pages), so these pages use the site's own fonts. Nothing else is allowed.
- Broken links on the static pages use the same layout (`Sahra.problem` in
  ui.js): a ticket link that is not valid, a party that does not exist, and staff
  pages opened while signed out. The door scanner keeps its minimal screen.
- Test: `test/notice.test.ts`.

### One sign-in: organiser and party owner are one role (9 October 2026)

Owner: party owners are single people, so there is no separate "organiser". On
the site everyone who runs parties is a party owner; guests read "the host".

- One sign-in page for everyone (`Sahra.signinView` in ui.js, used by /signin and
  by /platform when signed out); it always uses `/api/auth/google/start`.
- After sign-in, an account that may create parties (or the site owner) also gets
  the My parties session. With exactly one party it goes straight to that party's
  dashboard; otherwise to My parties (/platform).
- My parties lists every party the account runs (`GET /api/platform/teams`) with an
  Open button (`POST /api/platform/parties/:id/open`): a party session for the same
  Google account's own owner/admin row, created only while the My parties session
  is live (checked inside the insert), the same rule as choosing a party after
  sign-in. No second Google sign-in.
- Party pages show a "My parties" link when the account has that session, and
  Sign out ends both sessions.
- Under the hood the permission to create parties (and its party limit, set by the
  site owner) is unchanged, so not every Google account can create parties. The
  site-owner panel calls it "Party owners".
- Wording: "organiser" is gone from the site, emails' wording unchanged (they never
  used it); About, Privacy and Terms say "host" (same meaning, same version date).
- Contact page: "Date of party", "continue on WhatsApp or by Email"; the Settings
  example phone number is a made-up one (+20 100 000 0000).

### Spelling pass, and the last feature without a page (9 October 2026)

- Spelling: every English string (wording files, pages, server pages) checked with a
  dictionary and for repeated words, double spaces, dashes and stray punctuation;
  nothing wrong was found (British spelling throughout). The organiser page's tab
  title now reads "My parties".
- Every API route was matched against the pages. Without a page by design: the
  sign-in steps (server pages), the Drive backup (Apps Script) and test-only routes
  (off in production). The one real gap: releasing holds after a controlled
  recovery (`/api/recovery/holds`, `.../release-hold`). Guests now shows owners an
  "On hold after a recovery" card, only when something is on hold: each ticket or
  team member with why it was held, a reason field and Release.

### Up to three Gmail accounts (9 October 2026)

Owner: about 1500 tickets, so three platform Gmail accounts. Settings (secrets, set by
the owner): `GMAIL_ADDRESS` / `GMAIL_APP_PASSWORD`, optional `GMAIL_ADDRESS_2` /
`GMAIL_APP_PASSWORD_2` and `GMAIL_ADDRESS_3` / `GMAIL_APP_PASSWORD_3`, then Brevo as
before. They are used in that order; each account (`gmail`, `gmail2`, `gmail3`) has
its own rolling 24-hour cap of 450 (below Gmail's 500) and per-minute cap, and sends
from its own address. Three accounts plus Brevo: up to 1630 emails per 24 hours.
Speed is unchanged: 3 emails per one-minute run (the Workers Free CPU limit), so
about 180 per hour; 1500 emails take about 8 hours. No migration (provider names
are free text). Test: `test/email-sender.test.ts` (three accounts).
- Owner's helper: `email-accounts.bat` (project folder; runs `scripts/email-accounts.mjs`).
  The owner lists up to three accounts in `email-accounts.txt` (never committed, in
  .gitignore; see `email-accounts.example.txt`), double-clicks the .bat, picks staging
  or production and confirms. One `wrangler secret bulk` call sets all six secrets;
  slots not in the list are deleted. Passwords are never printed; the temporary JSON
  file is mode 600 and removed right after. Checked with a stand-in for Wrangler.

### Door scanner browser check (10 October 2026)

`scripts/scan-browser.mjs` (local server only): makes its own door invitation and
a fresh released ticket (no email address, so nothing is sent), opens admission,
turns the ticket page's real QR into fake camera video (ffmpeg), joins as door
staff and scans. Passes only if the first read is admitted and every later read of
the same code is "used". Replaces an old scratch script that no longer matched the
rebuilt join page.

### Your name on the sign-in button (10 October 2026)

Owner: the top-bar button showed the Gmail address (the name given at
create-site-owner) and a long one looked bad. Now:
- My parties has a "Your name" card (`POST /api/platform/me/name`): a normal name,
  1 to 80 characters, not an email. It is set on every row of that Google account
  (site owner, party-owner permission, active team rows), only while the My parties
  session is live (checked in each statement), audited, revs up so the change log
  records it.
- The button never shows a whole email address (only the part before @), the full
  name is on hover, and a long name ends in "…" (it was clipped because an
  inline-flex box ignores text-overflow).
- Test: `test/platform.test.ts` ("your own name").
