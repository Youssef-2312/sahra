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
| 1 | Foundation: stylesheet, wording (EN/AR), helpers, language switch | in progress |
| 2 | Guest sign-up page (`/signup.html?party=`): party, address status, ticket types, short form | |
| 3 | Guest ticket page (`/ticket.html#t=`): big QR, name/type/group, party, address or countdown | |
| 4 | Home page: party cards with the guest's own status; "Find my tickets" (needs backend) | |
| 5 | Door scanner: camera, full-screen verdicts, sound and vibration | |
| 6 | Organiser dashboard: top numbers and big buttons | |
| 7 | Approval queue: one card per request, "Approve and send QR" | |
| 8 | Party settings: details, ticket types, sign-up questions | |
| 9 | Guests: find, resend, add a cash guest, CSV import (needs backend) | |
| 10 | Site-owner panel: needs attention, parties, organisers | |
| 11 | Backend items from the brainstorm (docs/IDEAS.md on claude/brainstorm): support phone, refund policy and tracking, request reference, manual admit, one-tap approve+send, find my tickets | |

## Done so far

(nothing yet)

## Next

Piece 1: write `public/css/sahra.css`, `public/js/i18n.js`, `public/js/ui.js`.
