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
