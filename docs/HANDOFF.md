# Handoff: continue the Sahra staff-pages redesign

Paste everything below the line into another AI assistant that can work in a
local clone of the repository.

---

You are continuing work on **Sahra**, a ticket platform for private house parties.

- Repository: `Youssef-2312/sahra` on GitHub.
- Work branch: `claude/p5-frontend`. Pull it and work only on it.
- Stack: Cloudflare Workers Free, D1 (SQLite), Hono, TypeScript, and plain HTML/CSS/JS in `public/` (no framework, no build step for the frontend).

## Start here

1. `git fetch origin && git checkout claude/p5-frontend && git pull`
2. `npm ci`
3. Read these files:
   - `docs/PHASE5.md`: what was built and why.
   - `docs/HANDOFF.md`: this file.
   - The top comments of `public/js/staff.js`, `public/js/ui.js` and `public/js/i18n-staff.js`.
4. Checks. Both must pass before every commit:
   - `npx tsc --noEmit -p .` (typecheck)
   - `npx vitest run` (488 tests at handoff)

## Hard rules from the owner (never break these)

**Security and safety**
- A QR code being used twice is the worst possible failure. When in doubt, fail closed: the scanner shows "can't verify" or "paused", never green.
- No offline scanner mode.
- No passwords and no password hashing anywhere. Staff sign in with Google; door staff join from a one-time link.
- Never weaken a security measure to fit the free tier. If something does not fit, stop and give the owner options.

**Accounts and secrets**
- Never touch Halloween-26. That covers the Vercel project "hallowen-26", its GitHub repo, its Upstash Redis, and its Google Form and Apps Script. Read-only access only.
- Do not buy anything: no domains, no paid plans.
- Secrets are Cloudflare secrets set by the owner. Never ask for them in chat and never commit them.
- Do not use Google Drive as a live database. Never use party owners' Gmail accounts or app passwords.

**Ask the owner first**
- Ask before any action on the owner's accounts: creating Cloudflare, Vercel or Google resources, connecting repos, deploying, sending real email.
- Never deploy to production. Production deploys from `main` only after the owner merges a PR.
- Staging auto-deploys from the `staging` branch. Push there only with the owner's OK.
- Database migrations are applied by the owner, on staging first.

**Writing and design**
- No emojis in the UI or in emails.
- No em dashes in user-facing text.
- Professional wording: "Time" and "Location", not "When" and "Where".
- Every UI string exists in English and Arabic, and Arabic pages must mirror correctly (RTL).
- Design: flat dark style after Nova (bynova.vercel.app). No gradients or gloss. One accent colour (blue). Green, red and amber are used only for meaning.
- Report measured numbers, never guesses.

**Owner decisions**
- Only `youssefwaelkabbeel@gmail.com` is site owner.
- Guest details are deleted 7 days after the party, from backups too.
- "Built by Nova" links to https://bynova.vercel.app/. The Instagram handle is @novadev.co.

## Frontend conventions

**Content Security Policy**
- No inline scripts and no inline styles. Setting styles from JS via CSSOM, for example `el.style.width = ...`, is allowed.
- Images must be `'self'` or `data:` URLs.

**Shared helpers**
- `public/js/ui.js` exposes `Sahra`:
  - `t()` for translations;
  - `el(tag, props, ...children)` to build elements;
  - `api.get` / `api.post` / `api.me`;
  - `boot({ render, me })`, which draws the top bar and footer;
  - `money`, `when`, `title`.
- `public/js/staff.js` exposes `SahraStaff`:
  - `start({ page, title, lede, owner, actions, render })` builds a staff page with the staff menu and page head;
  - `act()` POSTs and retries on 503 "pending", reusing the same body;
  - form helpers: `field`, `input`, `select`, `check`, `section`;
  - `say()` / `sayBox()` for result lines, `why()` for error text, `tn()` for "1 email" versus "2 emails";
  - also `local()`, `copyButton()`, `nav()` and `redraw()`.

**Translations**
- Staff-page wording lives in `public/js/i18n-staff.js`. Every key must exist in both `en` and `ar`, with equal key counts.
- Check the counts with:
  ```
  node -e 'global.SahraText={en:{},ar:{}};eval(require("fs").readFileSync("public/js/i18n-staff.js","utf8"));console.log(Object.keys(SahraText.en).length,Object.keys(SahraText.ar).length)'
  ```
- Public and guest wording lives in `public/js/i18n.js`.

**Other conventions**
- Styles are appended to `public/css/sahra.css`. Staff page classes start with `.staff-`, `.s-`, `.g-`, `.o-`, `.tm-` and `.j-`.
- Every rule is enforced by the server, inside the SQL statement. Pages only show the server's answer.
- Actions that can be retried carry an `op` UUID that is kept until the server confirms, so a retry is the same change.

## Status at handoff

**Done and committed**
- Multi-ticket orders: separate QR codes per friend. Migration `0022`, `test/orders.test.ts`.

**Done in the latest work-in-progress commit**
- **Shared code:** `public/js/staff.js` (shared staff layout and menu, with a Sign out button) and `public/js/i18n-staff.js` (EN/AR wording).
- **Settings** (`party.html` / `party.js`): rebuilt as one card per part, each saved on its own:
  - Basics, Time, Location (reveal modes, lock, Reveal now), Requests, Rules and payment;
  - Pictures: upload and remove, using the existing `/api/party/flyers` endpoints;
  - Ticket types: list, editor and presets;
  - Guest form: proof of payment, ID photo and Instagram asks, plus a question builder that replaced the old JSON textarea;
  - Guest emails.
  - Browser-tested.
- **Guests** (`guests.html` / `guests.js`): live tiles; find a guest; resend ticket, new QR code, transfer, cancel; issue a ticket; message to guests. Browser-tested.
- **Emails** (`outbox.html` / `outbox.js`): tabs, "waiting for approval" banner with Approve all / Cancel all, per-row approve or cancel. Browser-tested.
  - Backend change: `src/routes/outbox.ts` now accepts `announce:<uuid>:<ticketId>` and `notice:<uuid>:<ticketId>` ids through `isOutboxId`.
  - New test in `test/outbox-routes.test.ts`.
- **Team** (`tools.html` / `tools.js`): people list with role change, switch off and take back invitation; door links with copy; Google invites. Browser-tested.
- **Requests** (`queue.js`) and **Overview** (`dashboard.js`) now show the staff menu.
- "Reject old waiting requests" moved into Requests, as a collapsible form on the Waiting tab.
- Deleted: `public/queue-tools.html`, `public/js/queue-tools.js` and `public/js/common.js`. They were old test pages.
- **Join page** (`join.html` / `join.js`): rebuilt on `ui.js`. Written but **not yet browser-tested**.

## What to do next, in order

1. **Browser-test the Join page.**
   - Use a door link from the Team page.
   - Check: Join works and goes to `/scan.html`; a used link shows the "already used" message; no console errors; English and Arabic both work.
2. **Rebuild `public/platform.html` and `public/js/platform.js`** (the organiser and site-owner panel). It is still an old raw test page with JSON dumps and id text boxes.
   - It has its own sign-in (`/api/platform/me`) and CSRF token. It does **not** use `SahraStaff.start`, because there is no party session. Reuse `Sahra.boot` and the `.s-card` / `.g-row` styles.
   - **Site owner part:**
     - Health checks (`/api/platform/health`): show each check as a row with an ok / problem / not set pill, plus usage, Discord status and recent alerts.
     - Organisers (`/api/platform/organisers`): list; invite (name and Gmail); disable; party limit.
     - Parties (`/api/platform/parties`), counts only: disable, enable, "Manage this party" (POST `.../manage`, then go to `/dashboard`), and a new owner invite for parties with `no_active_owner`.
     - Site owners list.
   - **Organiser part:** my parties (`/api/platform/my-parties`), and a create-party form (id, name, capacity, `staff_id` UUID).
   - Keep every confirm dialog that the old page had.
   - Read `src/routes/platform.ts` for the exact request and response shapes.
3. **Browser-check every staff page** at 390, 768 and 1440 px wide, in English and Arabic:
   - no horizontal overflow (`document.documentElement.scrollWidth - innerWidth` must be 0);
   - no console errors.
4. **Polish if time allows:**
   - the guest ticket page (`ticket.html` / `ticket.js`);
   - the scanner (`scan.js`), without changing any verdict logic.
5. **Update `docs/PHASE5.md`** with an entry for the staff pages redesign.
6. **Commit and push** to `claude/p5-frontend`. Run the typecheck and tests first.
7. **Tell the owner:**
   - **Migrations:** apply 0020, 0021 and 0022 on staging, if not done yet. Run `git pull` on `claude/p5-frontend`, then `npx wrangler d1 migrations apply sahra-staging --remote --env staging`.
   - **Deploy:** ask before pushing to the `staging` branch.
   - **Known gaps:**
     - ID photos are only asked from the buyer, not from friends on multi-ticket orders.
     - The Drive backup is not active yet.
     - "Find my tickets" is not built.

## Local testing

**Dev server**
- Create `.dev.vars` with random test keys. See `scripts/` or the README; never use real secrets.
- Start it with:
  ```
  npx wrangler dev --env staging --port 8799 --ip 127.0.0.1 --persist-to ./.devstate --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var PUBLIC_ORIGIN:http://127.0.0.1:8799
  ```
- Apply local migrations with:
  ```
  npx wrangler d1 migrations apply DB --local --env staging --persist-to ./.devstate
  ```

**Browser tests**
- Use Playwright with a staff session cookie `__Host-sahra_s`, created through the staging test routes or a seeded session.
- The local Worker cannot reach Turnstile, so stub `challenges.cloudflare.com` in browser tests of the guest request form.
