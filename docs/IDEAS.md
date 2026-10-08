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
- Emails: owner decision, "emails are always english". All emails are in English whatever language the guest picked on the site, so no guest-language field is needed. (Pages still have the switch; the organiser's own text is shown as typed.)

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
  - cap of 5 questions per party (owner decision: "orgainsers are capped at 5 extra questions");
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

## 8. Scanner: "Find guest" and manual admit

- Status: agreed
- Owner's words: "yes"
- For guests whose QR will not scan (cracked screen, dead phone): a "Find guest" button on the scanner. Staff type a name, see matches and status.
  - not yet used: staff can admit by hand through the same single-redemption path as a scan, so a ticket still can never be admitted twice;
  - already used: shows when and where, like a scan.
- Manual admits are marked "manual" with the staff member who did it, so the organiser can review them afterwards (list or filter in the dashboard).
- Needs: a manual-admit action on the server that reuses the scan redemption rules (not a separate shortcut); a "manual" flag on the scan record; a review list. Builds on the staff search already being built.
- Effort: medium
- Free-tier cost: same as a scan (2 rows main + 1 ledger row); searches are reads
- Rule conflicts: the worst-failure rule applies. It must use the same atomic redemption, check the party is open and not paused, and fail closed (amber) if the ledger write cannot be confirmed. If it cannot meet that, do not build it.

## 9. Organiser adds cash guests, one by one or by spreadsheet import

- Status: agreed
- Owner's words: "yes orgainsers adds a guest who paid cash or imports an excel sheet with their email and writes that its paid in cash and that the approvals should be done and the qrs should be sent"
- One guest: the organiser types name, email, ticket type and people. No payment screenshot needed. The ticket is approved at once, marked "paid in cash", and the QR is sent.
- Many guests: the organiser imports a spreadsheet with name and email (and ticket type if more than one). One setting for the whole file: "paid in cash", approve all, send QRs. A preview screen shows every row, flags problems (bad email, duplicates, over capacity, over the max tickets per email) and nothing is created until the organiser confirms.
- Dashboard: a separate "Cash" total beside "Money expected", and a filter for cash tickets in the guest list and export.
- Needs: add-guest form and import screen in the organiser dashboard; a payment-method flag on the ticket ("cash" vs "screenshot"); the server must apply the same rules as a normal sign-up and approval (hard capacity inside the statement, max per email, audit with the organiser's name, change log and intents). Email goes through the normal outbox.
- File format (recommend): CSV, or paste rows copied from Excel, read in the browser. A real .xlsx file needs a heavy reading library on a phone; the organiser can use "Save as CSV" in Excel. Owner decision: "csv". Provide a downloadable CSV template (name, email, ticket type, people) so organisers know the columns.
- Effort: medium to large
- Free-tier cost: about 4 to 5 rows written per guest (ticket, change log, outbox, audit), so 300 guests is roughly 1,500 rows, fine. Large imports should be done in chunks so no single request goes over 50 queries or 10 ms CPU. The bigger limit is email: QR emails leave a few per minute through the outbox and count against the Gmail daily cap, so a big import may take a while to finish sending. The dashboard should show "x of y QRs sent".
- Rule conflicts: none, if capacity and QR issuing use the same code as normal tickets. An imported guest must never get a QR that skips the capacity check. Emails contain no emojis.

## 10. Organiser dashboard: top of the page

- Status: agreed
- Owner's words: "its correct"
- Top of the dashboard, phone first:
  - tickets approved out of capacity (for example "86 / 120");
  - requests waiting for approval, with a big "Review" button;
  - money expected (from approved tickets and prices) with a separate "Cash" total (idea 9);
  - countdown to the party, then "Doors open" with the number checked in once it starts.
- Below: big buttons to open or close registration, send an announcement, add a cash guest or import a CSV, and open the guest list.
- Needs: one screen on data that already exists or is being built (capacity indicator, check-in stats, ticket prices); cash total needs the payment-method flag from idea 9.
- Effort: medium
- Free-tier cost: a few counts per page view; cache them for a short time and avoid refreshing in a tight loop
- Rule conflicts: none

## 11. Approval queue: one card per request, one-tap approve and send

- Status: agreed
- Owner's words: "I agree with ur option but also include a one tap"
  (read as: keep plain "Approve" and add "Approve and send QR" as a one-tap action; the one-tap is the main button)
- One card per waiting request, phone first:
  - guest name, email, ticket type, people, and answers to the organiser's extra questions;
  - payment screenshot, large, tap to zoom;
  - the amount expected for that ticket type shown beside the screenshot;
  - buttons: "Approve and send QR" (primary, one tap), "Approve" (QR sent later), "Reject" (asks for a reason the guest sees).
- Bulk: select several cards and approve (with or without sending QR) or reject in one go.
- Needs: queue screen; a combined approve-and-release action that does approval and release in one server change (approval and release stay two separate recorded steps, as already decided, but one tap triggers both in order; if release fails, the ticket stays approved and the card says "approved, QR not sent yet" with a retry).
- Effort: medium
- Free-tier cost: screenshots are the heavy part; load them one card at a time or on tap, small previews first, to protect the daily read budget and mobile data. Emails go through the outbox (daily Gmail cap applies).
- Rule conflicts: none. Capacity is still enforced inside the approval statement; if full, the card says so and nothing is approved.
- Simplicity requirement (owner: "but make sure its simple"): the card shows only what is needed to decide: name, ticket type, screenshot with the expected amount, and the buttons. Extra answers and email are hidden behind a small "Details" tap. The big green button "Approve and send QR" is the obvious default; "Approve" without QR and "Reject" are smaller and secondary. No settings, no extra steps, no confirmation pop-up for approve (an "Undo" for a few seconds instead is preferred if it is safe: it must not apply once a QR email is queued).

## 12. Design principle: clean and uncluttered everywhere

- Status: agreed
- Owner's words: "I dont want the website to look clustered or too complex" (also "but make sure its simple", about the approval queue, idea 11)
- Applies to every screen (guest, organiser, door scanner, site owner), on top of mobile first (idea 6).
- Proposed rules for the Phase 5 build:
  - one main job per screen, with one obvious primary button; everything else is smaller or behind a "More" or "Details" tap;
  - lots of white space, one column, few colours; colour is kept for meaning (green admitted/approve, red rejected/used, amber uncertain);
  - short plain wording, no jargon; no emojis;
  - forms show only the fields needed; organiser extras only appear when the organiser added them;
  - rarely used settings live on a separate settings page, not on the main dashboard;
  - the door scanner shows nothing except the camera and the result.
- Open question: for the approval queue, the owner's remark about "different fields for the button" was answered with this principle, not a specific layout. The coordinator should treat this principle as the answer.
- Needs: a rule for the whole build, no new data. Effort: no extra screens; it shapes all of them.
- Free-tier cost: none; lighter pages help
- Rule conflicts: none

## 13. Site-owner panel: small and simple

- Status: agreed
- Owner's words: "nope" (when asked whether anything else was needed in the panel)
- Three parts only:
  - "Needs attention": health alerts (failed backup, database nearly full, unusual daily usage). Says "All good" when there is nothing;
  - "Parties": short list with organiser, status and ticket count, plus a switch to disable or re-enable a party;
  - "Organisers": invite one, change their party limit, disable one.
- Amended by idea 19: the party switch becomes a labelled "Disable party..." action with a confirmation screen.
- Needs: one screen on actions that already exist (Workstream B and F); no new data.
- Effort: small to medium
- Free-tier cost: a few reads per page view; the health status is read from the stored state, not recomputed
- Rule conflicts: none; follows ideas 6 and 12 (phone first, uncluttered)

## 14. Clear payment, refund policy and refund tracking (from the outside review)

- Status: agreed
- Owner's words: "yes" (to the refund proposal); earlier, about the review: "all the party owners to include refunds or not"
- Source: outside review by another AI, passed on by the owner.
- Before payment, the sign-up page shows: who receives the money, the organiser's refund policy, and the organiser's contact.
- Refund policy is the organiser's own short text per party (for example "No refunds", "Refund up to 48 hours before", "Refund only if the party is cancelled"). Each organiser decides whether refunds are offered at all.
- Refund tracking is separate from ticket status: "Refund due" and "Refund completed". Sahra only records refunds; it never sends money and never claims to.
- Cancelling a party: stops registration and admission, emails the guests, and gives the organiser a refund checklist (paid tickets marked "Refund due" when the policy allows). The organiser ticks "Refund completed" after paying back outside Sahra.
- Needs: new party fields (refund policy text, payee name, contact); a refund status on tickets; a party-cancel action (build on the existing pause and disable-party actions, which already stop admission); one email template; a checklist screen. A change to ticket or party state must follow the existing change-log and intent rules.
- Effort: medium
- Free-tier cost: a cancel notifies every guest through the outbox, so a big party uses a lot of the Gmail daily cap and takes a while to finish; show "x of y emails sent"
- Rule conflicts: none; no payments are handled by Sahra. Wording: "Sahra records refunds, it does not send them".

## 15. After sign-up: reference, saveable link, review time, contact, and organiser-assisted recovery

- Status: agreed
- Owner's words: "I agree with ur recommendation"
- Source: outside review by another AI, passed on by the owner.
- Confirmation page and email show:
  - a short request reference (for example "SAH-4821") the guest can quote to the organiser;
  - the private ticket link with a clear "Save this link" note;
  - an expected review time, set by the organiser per party (for example "usually within 24 hours");
  - the organiser's contact;
  - once the QR is released, a "Save QR" button;
  - a plain note: "This device remembers your tickets. On another device, use Find my tickets."
- Wrong email or lost access: the guest contacts the organiser and quotes the reference. The organiser checks details only the guest would know (name, amount, payment time, screenshot) and can change the email on the guest card. Knowing a name alone is never enough. The change is audited with the organiser's name and a notice goes to the old address.
- Needs: a reference field on tickets (short, unique per party, not guessable as a way into a ticket; it identifies, it does not authorise); organiser setting for review time; an "edit email" action on the guest card under the change-log and intent rules (it changes who can receive the ticket link, so it must also invalidate the old private link and issue a new one); one email template.
- Effort: medium
- Free-tier cost: small; a few more fields, one extra email only when an email is changed
- Rule conflicts: the reference must never work as a key to open a ticket (the private link stays the only access). Fail closed: if the link is reissued, the old link and QR stop working. No emojis.

## 16. Organiser support contact: required phone or WhatsApp number

- Status: agreed
- Owner's words: "A phone or WhatsApp number. required"
- Each party must have a support phone or WhatsApp number (required before the party can open registration). Optional extras: an email and a short availability line (for example "Available 6pm to midnight on party day").
- Shown on: the sign-up page (next to the payment instructions and refund policy), the confirmation page and email, the guest ticket page, and the door scanner screen (so staff can call the organiser during a problem).
- Privacy note for the coordinator: the number is public to anyone who opens the party page, so the organiser should be told that when they enter it (it is their own choice of number; it should not be a personal number they want to keep private). Not part of the hidden-address rules.
- Needs: new party field(s) with basic format checks; show them in the four places above; make "support number set" a condition for opening registration. Wording must not suggest Sahra itself provides support.
- Effort: small
- Free-tier cost: none
- Rule conflicts: none

## 17. Cash import: confirm summary and "send now or later" (change to idea 9)

- Status: agreed (amends idea 9)
- Owner's words: "yes thats ok"
- Source: outside review suggested not sending QRs on import; the owner kept the one-go flow with a safety step instead.
- The preview screen ends with a plain summary (for example "Add 120 guests, paid in cash, send 120 QR emails") and one "Confirm and send" button. Nothing is created before it is tapped.
- A choice on that screen: "Send QRs now" (selected by default) or "Add only, send later". "Add only" puts the guests in the approved list with QRs not yet released; the organiser can release them later (all at once or one by one).
- The preview still flags duplicates, bad emails, over-capacity rows and over the max-tickets-per-email.
- Needs: one extra option on the import screen; reuse the existing release step. Effort: small on top of idea 9.
- Free-tier cost: as idea 9
- Rule conflicts: none

## 18. Sign-up form starts with no extra questions (amends idea 3)

- Status: agreed
- Owner's words: "yes"
- Source: outside review by another AI.
- A new party's form has only the fixed fields (name, email, ticket type, people, payment screenshot). Organiser questions are added only when the organiser chooses. The form builder shows a short note: "Every question makes fewer guests finish signing up."
- Needs: default of zero questions plus one line of text. Effort: small. Free-tier cost: none. Rule conflicts: none.

## 19. Disabling a party is a labelled, confirmed action, not a switch (amends idea 13)

- Status: agreed
- Owner's words: "yes"
- Source: outside review by another AI.
- In the site-owner panel the party on/off switch is replaced by a button "Disable party..." that opens a screen explaining the effect in numbers, for example "Registration stops, admission pauses, and 86 guests cannot enter." The site owner types the party's name to confirm. Re-enabling is a single clear action, with a short explanation of what it brings back.
- Needs: confirmation screen using counts the server already has; the existing disable-party action (which pauses the party and ends its sessions) and its change intent stay unchanged. Effort: small.
- Free-tier cost: a couple of counts when the screen opens
- Rule conflicts: none; consistent with fail closed (a disabled party admits nobody).

## 20. Look and feel: "newform", hero photos, logo, favicon, organiser "fillers" on cards

- Status: open (several words need confirming with the owner)
- Owner's words: "also for the frontend I want newform used and these pictures used as a hero I also want a logo generated for sahra and the favicon to also be generatted and I want the oraginers to be able to add their own fillers on their cards"
- "newform": owner says it is "a website for html blocsk" (a site of ready-made HTML blocks to copy into the pages). A web search did not find it, so the exact site, its licence and its price are NOT confirmed. Owner to give the link. Conditions: the blocks must be free to use in a live site, with no purchase and no paid plan; nothing may be loaded from an outside site at run time (copy the HTML and CSS into the project, no outside scripts), because the pages must work fast on weak mobile data and must not depend on a third party at the door; each block must be checked for phone layout, right-to-left Arabic and the clean, uncluttered rule (ideas 6 and 12).
- Hero pictures: the owner shared three night-party crowd photos (a dark venue with hands raised, a dancing crowd under a wall of studs, a costume party). They are held in the owner's chat only, not in the repository. The owner has to hand the files to the coordinator. Owner says: "i have premission" (permission to use the photos is confirmed by the owner). Remaining points: that nobody in the photos looks under age for a ticketed party page; and file size (resize and compress each photo for phones, aim under about 150 KB each, a single hero image per screen load; static assets do not count as Worker requests). Mobile first (idea 6): the dark, busy photos need a dark overlay so white text stays readable.
- Logo and favicon: the owner wants them generated for Sahra. The brainstorm session cannot make images. Recommend a simple wordmark (the name "Sahra" in a bold typeface) as an SVG, which is free, sharp on every phone and tiny; the favicon is the first letter in the same style. The coordinator can draw it in SVG code, or the owner can use any image tool.
- "Fillers" on cards: unclear, possibly "flyers" (each organiser uploads their own flyer or cover image for their party card). If so, it needs: an image upload per party, a size cap and resize in the browser, and storage in the files database (no R2); the 500 MB database size limit and the daily write budget apply, and the existing size health check should count it.
- Effort: unknown until the words are confirmed
- Rule conflicts: none so far; no R2; nothing bought (no paid fonts or stock images); no emojis in the interface.

## 21. Organiser flyer or cover image on the party card (part of idea 20)

- Status: agreed
- Owner's words: "yes thats correct" (to: each organiser can upload their own flyer or cover image for their party card)
- Each organiser can upload one flyer or cover image per party. It shows on the party's card on the home page and at the top of the party's sign-up page. If none is uploaded, the card uses a plain default style (or a shared hero photo).
- Needs: one image upload on the party settings screen; resize and compress in the browser before upload (phone first); storage as a BLOB in the files database, as screenshots already are (no R2); allowed types and a hard size cap (suggest about 300 KB after shrinking, JPEG or WebP only); a way to replace or remove it.
- Effort: medium
- Free-tier cost: each upload is a few rows written; the image counts toward the 500 MB database limit and the existing database-size health alert. Guests loading it counts as reads, so serve it with caching so repeat visits do not re-read it (home page cards could use a small thumbnail).
- Rule conflicts: none. No R2. A hostile or oversized file must be refused (check type and size on the server, do not trust the browser). Organiser-uploaded images are shown as given; the site owner can remove one.

## 22. Building blocks for the screens: newform and efferd (part of idea 20)

- Status: agreed (inspiration only, plain static HTML; newform still unseen)
- Owner's words: "https://www.newform.com/  https://efferd.com/blocks/dashboard"
- Checked by the brainstorm session:
  - newform.com: the page could not be opened from here (404 on both www and the bare address), so what it offers, its licence and its price are NOT confirmed. Owner to say what block or page on it they like, or paste a screenshot.
  - efferd.com/blocks/dashboard: 14 dashboard blocks "for shadcn UI". Dashboards 1 to 5 are marked Free, 6 to 14 are marked Pro (paid). Licence terms were not visible on the page. They are written for shadcn UI (React with Tailwind and Radix, installed as packages), not plain HTML.
- Points for the coordinator and owner:
  - Only free blocks may be used (no paid plan, no purchase). Check the licence on the site before copying any block into the project.
  - The blocks are React, so using them means a React build step. Check this fits the current static-page setup and Workers Free limits (no extra Worker CPU: pages are static assets, free of request counts). A lighter alternative is to use the blocks only as a visual reference and write plain, small HTML and CSS pages.
  - Nothing loads from the sites at run time; copy what is used into the project.
  - Phone first, right-to-left Arabic, and clean and uncluttered rules (ideas 6 and 12) apply to every block. A dashboard block is desktop-minded by default; the organiser dashboard must still be designed for a phone first.
- Recommendation (not yet agreed): use the free dashboard blocks as inspiration for the organiser dashboard and site-owner panel, and keep the guest pages and door scanner as small custom pages, because they are the most phone-critical and need the least code weight.
- Owner decision: "as inspiriation not react I woudl rather it being written in static hmtl". The blocks are inspiration only. All frontend pages are written as plain static HTML, CSS and a little JavaScript. No React and no build framework. No block is copied from a paid or unclear-licence source.
- Why this fits: static pages are Workers static assets (not counted as requests), load fast on mobile data and have no outside dependency at the door.
- The open question about newform remains: the owner is to show what they like on it (screenshot or description).

## 23. Logo and favicon: decide later

- Status: open
- Owner's words: "im not sure about the favicon or the logo yet"
- Nothing is to be built for the logo or favicon yet. Until the owner decides, the pages use the plain text name "Sahra" in a bold typeface and no custom icon. When the owner is ready, the options are: a simple "Sahra" wordmark with an "S" favicon drawn as a small SVG (free, sharp on phones), or an image the owner supplies. The brainstorm session cannot generate images.
- Effort: small. Free-tier cost: none. Rule conflicts: none (nothing bought; no emojis).

## 24. Year-round look: no Halloween theme

- Status: agreed
- Owner's words: "also please make sure that this website isnt themed in certain halloween colors since I want it to be open all year long"
- The site must look right in every season: no orange and black, no pumpkins, ghosts, blood red or spooky wording as the base style. Use a neutral, party-neutral palette (for example a dark charcoal base with one calm accent colour) that organisers' own flyers can sit on without clashing.
- Hero photos (idea 20): the brainstorm session suggested avoiding the costume-party image and the venue photo with the red signs. Owner decision: "using the hero photos is okay you can keep". All three photos stay as the owner supplied them. The site's own colours, text and icons still stay non-seasonal.
- Colours: owner agreed to a dark charcoal base with one calm accent colour ("yea I agree with the dark charocal base with a calm accent colour that would be nice"). The exact accent colour is left to the coordinator to propose; keep text contrast high for phones in sunlight and in the dark.
- Organisers can still theme their own party through their flyer and text (idea 21). That is their party, not the site.
- Also keep the separate Halloween-26 project untouched; this is only about Sahra's look.
- Needs: a colour and tone rule for the frontend build and the photo choice. Effort: none extra. Free-tier cost: none. Rule conflicts: none.

## 25. Dashboard look: the owner likes the efferd dashboard style

- Status: agreed as a visual reference only (not copied; static HTML, idea 22)
- Owner's words: "dashboard is relaly nice" (screenshot of the efferd dashboard: near-black background, thin grey borders, a row of four number tiles with small "vs last week" changes, bar and line charts, a left sidebar, recent-items table and activity list)
- What to take from it: the dark charcoal look (matches idea 24), thin-bordered tiles with one big number each (matches the top of the organiser dashboard in idea 10: approved out of capacity, waiting requests, money expected, cash, countdown), plenty of spacing, small muted labels, tables with few columns.
- What to change for Sahra:
  - phone first (idea 6): no permanent left sidebar on a phone; use a simple top bar with a menu button, and a stack of single-column tiles;
  - uncluttered (idea 12): far fewer panels than the screenshot; no billing, API keys, integrations or changelog areas;
  - charts only if they earn their place: at most one small chart (sign-ups per day) drawn as inline SVG or plain CSS, no chart library, so pages stay light;
  - tiles use Sahra's real numbers, and the same look serves the organiser dashboard and the site-owner panel (idea 13).
- Needs: a visual style guide for the coordinator's frontend build. Effort: no extra screens.
- Free-tier cost: none (static pages; no chart library)
- Rule conflicts: none; colour kept for meaning only (green good, red bad, amber uncertain).
- Which one: owner says "its dashboard 2" (the efferd block numbered dashboard 2 on efferd.com/blocks/dashboard; dashboards 1 to 5 are listed as free, but the licence terms were not visible, so the coordinator must check them before using anything beyond the look; inspiration only).

## 26. Dashboard 3 also liked: soft rounded cards and a few charts

- Status: agreed as a visual reference only (inspiration, static HTML, idea 22)
- Owner's words: "3 is also nice" (screenshot of efferd dashboard 3: dark rounded cards, a line chart with a "Last 30 days" dropdown, a donut chart split by channel, vertical bar columns, a line of dots with labelled values)
- What to take: the softer rounded cards, the "last 30 days" style dropdown on a chart, a donut for shares, small labelled values on charts.
- Possible Sahra charts (only if the owner wants them, phone first, idea 12 applies): sign-ups per day (line); ticket-type split (donut); on party night, arrivals per 15 minutes (bars) so the organiser can see the door queue building.
- Needs: chart screens drawn with inline SVG or plain CSS, no chart library; the server provides small pre-counted numbers (per day, per type, per 15 minutes) rather than scanning every ticket on each page view.
- Effort: medium (small per chart)
- Free-tier cost: counts should be computed with a few cheap grouped reads and cached for a minute or so, so a busy dashboard does not burn the 5M rows read per day. Do not refresh charts in a tight loop.
- Rule conflicts: none. Charts must never be the only way to see a number (the tiles from idea 10 stay).

## 27. Sign-in page look: efferd auth-9 style

- Status: agreed as a visual reference only (inspiration, static HTML, idea 22)
- Owner's words: "this is nice aswell" (screenshot of efferd auth-9: a dark split page, a rounded hero panel on the left with a big headline, and on the right a short sign-in form with "Continue with Google", other provider buttons, an "OR" line and an email box)
- For Sahra (staff sign-in for organisers and site owners):
  - one button only: "Continue with Google" (the only sign-in that exists; no Vercel, GitHub or other providers);
  - NO email box or "Continue with email": there are no passwords and no email sign-in. Door staff do not use this page at all; they join through their one-time invitation link;
  - left panel: one of the owner's hero photos with a short headline and one line of plain text (no "trusted by" logos); on a phone the panel becomes a short strip above the button, so the button is visible without scrolling (idea 6);
  - a line under the button that sign-in is by invitation only, so nobody expects to create their own account (decided: organisers join by invitation);
  - separate sign-in pages for organisers and for the site owner stay separate (separate cookie, already built).
- Needs: one static page per sign-in type. Effort: small. Free-tier cost: none. Rule conflicts: none (no passwords; Google sign-in as already built).
- Owner decision on charts: "yes all three". The organiser dashboard gets all three charts below the number tiles: sign-ups per day (line), ticket-type split (donut), and arrivals per 15 minutes (bars). Suggested placement: sign-ups and ticket types before the party; the arrivals chart appears once doors open. Tiles stay at the top (idea 10), and each chart sits below on a phone as a single full-width card.
