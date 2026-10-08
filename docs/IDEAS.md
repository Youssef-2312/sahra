# Ideas from the brainstorm session

Proposals only. The coordinator builds an idea only when the owner says so in the
coordinator's session. Status: agreed, rejected or open.

## 1. Guest pages: English by default, small language switch

- Status: agreed
- Owner's words: "should defualt to english and small switch at time and the own test shown as how the oragainser typed it"
  (read as: default English, a small switch at the top, and the party's own text shown exactly as the organiser typed it)
- Needs:
  - screens: a small English / Arabic switch at the top of every guest page; the guest's choice is remembered in the browser;
  - Arabic pages must be built right-to-left from the start (cheaper now than later);
  - wording for fixed text (buttons, labels, errors, emails) in both languages;
  - party name, description, rules and other organiser text are NOT translated and are shown as typed;
  - new data: none required (the choice lives in the browser). Optional later: a guest language field so emails use the same language.
- Effort: medium (mostly writing and checking Arabic wording, and RTL layout)
- Free-tier cost: none (static assets do not count as Worker requests)
- Rule conflicts: none. No emojis in either language.
- Open point: do emails follow the guest's language? Not yet asked.

## 2. Guest sign-up page: order of content

- Status: agreed
- Owner's words: "this is the right order"
- Order, top to bottom:
  1. party name, date and time;
  2. address status (for example "revealed 2 hours before"; a hidden address never reaches the browser early);
  3. ticket types with prices, each showing "sold out" or "closes in 3 days" where it applies;
  4. a short sign-up form.
- Needs: one screen; uses data that already exists (party details, ticket types, sales windows). No new data.
- Effort: small to medium
- Free-tier cost: none (static page plus one read of the party's public details per visit)
- Rule conflicts: none

## 3. Sign-up form: fixed fields plus organiser-added questions

- Status: agreed
- Owner's words: "yes and an option for the orgainser to add other fields?" and "yea add an opition for long test field aswell we wanna be verstalie you never know"
- Fixed fields: full name, email, ticket type, number of people, payment screenshot (shown after the payment instructions for the chosen type). No phone number unless the organiser adds it as a question.
- Organiser-added questions (the backend already stores per-party questions in `parties.guest_form`, answers in `tickets.answers`):
  - field types: short text, long text, dropdown, yes/no tick box;
  - required or optional per question;
  - recommended cap of 5 questions per party (open: owner has not confirmed the cap);
  - answers shown in the approval queue and in the guest list export.
- Needs: a form-builder screen in the organiser dashboard; the sign-up page draws the questions. Backend may need the long-text and dropdown types added, and a length limit on answers (check what `POST /api/tickets/form` accepts today).
- Effort: medium
- Free-tier cost: none beyond sign-up writes already counted (answers are part of the ticket row; keep answer length capped)
- Rule conflicts: none

## 4. Home page: party cards with the guest's own status on the card

- Status: agreed (with the "Find my tickets" box below; full email accounts were considered and declined for now)
- Owner's words: "let them get a status page but that status is displayed under the party they signed up for example ... Consider this the hero ... Party A Party B Party C ... I sign up at party A ... Party A Party B Party C awaiting"
- Meaning: the home page shows the parties side by side as the hero. After a guest signs up to a party, that party's card shows the guest's status (awaiting, approved, ticket ready, rejected with the organiser's reason). Other cards are unchanged.
- How it would work without accounts or passwords: the browser remembers each ticket link (the signed link already used for the guest ticket page) and asks the server for the status of each. The guest cannot see status on another device except through the emailed link or "resend my ticket link".
- Needs: home page screen; a small browser store of ticket links; a status read per remembered ticket (could be one batched read). No new data.
- Effort: medium
- Free-tier cost: one read per remembered ticket per visit; keep the status request batched and cached briefly so a busy page does not burn the 100K requests/day
- Rule conflicts: none (no passwords, no accounts; the hidden address must still not appear on cards before reveal)
- Owner decision on devices: "alright the middle". Status shows on the party card in the browser that signed up. On any other device the guest uses a "Find my tickets" box on the home page: they type their email and get ONE email with the links to all their tickets across all parties. Answer is the same whether or not the email exists. No accounts, no sign-in.
- Extra needs for "Find my tickets": one email template (no emojis), a cross-party lookup by email, and a per-email send limit so nobody can use it to spam an inbox. Effort small, on top of the existing "resend my ticket link". Counts against the daily email cap (Gmail), so keep the limit tight.
- Declined for now: full guest accounts with email sign-in link or code (large effort, more email volume, more door-budget traffic). Can be revisited.

## 5. Guest ticket page: order of content

- Status: agreed
- Owner's words: "yes thank you"
- Order, top to bottom:
  1. very large QR on a white background, with "Turn your screen brightness up";
  2. guest name, ticket type, number of people (a group QR says for example "Group of 4");
  3. party name, date, entry-from time;
  4. the address, or the countdown to its reveal;
  5. organiser announcements, if any.
- If the ticket is cancelled, on hold, or not yet released, the QR is replaced by a plain message (fail closed: never show a QR that will not work).
- Needs: one screen on existing data (ticket, ticket type, party, announcements). No new data.
- Effort: small to medium
- Free-tier cost: one read per page view; static page itself is free
- Rule conflicts: none. Hidden address stays hidden until the server reveals it.

## 6. Mobile first for every screen

- Status: agreed (owner asks that this be added to the decisions; I can only edit this file, so the coordinator should copy it into `docs/DECISIONS.md` when the owner confirms there)
- Owner's words: "add to the decisions that mobil is the biggest necessity since most traffic is going to e from mobile numbers"
- Meaning: design every screen for a phone first (guest pages, ticket page, door scanner, and also the organiser dashboard and site-owner panel); desktop is a bonus, not the main target.
- Practical effects to carry into the Phase 5 build:
  - one-column layouts, large tap targets, text readable without zooming;
  - forms usable with a thumb, with the right keyboard per field (email, number);
  - payment screenshot upload straight from the phone camera or gallery, with the photo shrunk in the browser before upload where possible (smaller upload, fewer failures on weak mobile data);
  - light pages that load fast on mobile data (no heavy images or libraries);
  - the QR and scanner results readable in sunlight and in a dark room;
  - test on small and old phones, not only on a desktop browser.
- Needs: a rule for the whole build, no new data. Effort: no extra screens, but it shapes the effort of all of them.
- Free-tier cost: lighter pages help; static assets do not count as Worker requests
- Rule conflicts: none

## 7. Door scanner result screens

- Status: agreed
- Owner's words: "yes thats correct the staff should see the guests name and the word"
- Whole screen turns one colour with one big word:
  - green "Admitted": guest name, ticket type, group size (so staff can greet the guest and spot a borrowed ticket);
  - red "Already used": when it was used and at which scanner;
  - red "Invalid": forged or wrong-party code;
  - amber "Can't verify" or "Paused": anything uncertain. Never green when in doubt.
- Each result also has its own sound and vibration so staff need not watch the screen constantly.
- Phone first (idea 6). Large QR-reading area, high contrast for dark rooms.
- Needs: scanner screens on existing scan results. The "Already used" detail (time, scanner) needs the scan response to include it; check what the API returns today.
- Effort: medium
- Free-tier cost: none beyond scans already counted
- Rule conflicts: none; consistent with fail-closed. No emojis: colours, words, sound and vibration only.
