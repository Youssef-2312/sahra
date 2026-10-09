#!/usr/bin/env node
// STAGING ONLY: ten demo parties with ticket types and pictures, so the home page
// can be checked with real-looking data. Uses the staging-only test route
// (POST /api/test/party, ENABLE_TEST_TICKETS = "1"; production answers 404) and
// then the normal organiser routes, exactly as an owner would.
//
//   node scripts/demo-parties.mjs --invite "https://sahra-staging.<you>.workers.dev/join#t=..."
//
// The invitation is any door-staff invitation link of an existing staging party
// (it is used once, to get a session that may create test parties). Pictures are
// the owner's photos in public/img/hero (demo data only). Needs migrations
// 0016, 0017 and 0018 on staging. Some parties get entry rules and a cancellation
// policy (the request form's Terms box covers them). Prints the parties it made;
// their owner sessions expire in 3 hours.

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const invite = arg("--invite");
if (!invite || !invite.includes("#t=")) { console.error('usage: node scripts/demo-parties.mjs --invite "https://<staging>/join#t=..."'); process.exit(2); }
const base = new URL(invite).origin;
// Staging, or a local dev server (--local) for a dry run.
if (!/staging/.test(base) && !(process.argv.includes("--local") && /^http:\/\/(127\.0\.0\.1|localhost):/.test(base))) {
  console.error(`Refusing: ${base} does not look like staging.`); process.exit(2);
}
const inviteToken = invite.split("#t=")[1];
const token = () => randomBytes(32).toString("base64url");

async function call(method, path, body, sess, extra = {}) {
  const headers = { origin: base, "sec-fetch-site": "same-origin", ...extra };
  if (sess) { headers.cookie = `__Host-sahra_s=${sess.token}`; if (sess.csrf) headers["x-sahra-csrf"] = sess.csrf; }
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(base + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
async function withCsrf(t) {
  const me = await call("GET", "/api/me", undefined, { token: t });
  if (me.status !== 200) throw new Error(`session check failed: HTTP ${me.status}`);
  return { token: t, csrf: me.body.csrf };
}
function must(r, what) {
  if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const pad = (n) => String(n).padStart(2, "0");
function local(daysAhead, hour) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(hour)}:00`;
}

// [name, days ahead, start hour, [type, price]..., capacity, pictures (hero-N)]
const RULES = "Over 21. Bring your ID. No outside drinks.";
const CANCEL = "Full refund until 7 days before the party. Half refund until 2 days before. No refunds after that.";
// Which parties get entry rules / a cancellation policy (by index in PARTIES).
const WITH_RULES = new Set([0, 2, 3, 5, 8]);
const WITH_CANCEL = new Set([0, 3, 6, 8, 9]);

const PARTIES = [
  ["Rooftop Sessions", 3, 22, [["Entry", 350]], 120, [2, 9, 4]],
  ["Garden Disco", 5, 21, [["Early", 300], ["Regular", 450]], 0, [4]],            // capacity 0: sold out
  ["Neon Nights at the Villa", 7, 23, [["Entry", 500]], 200, [10, 1]],
  ["Midnight Masquerade: An All-Night Costume Party With Two Live DJs and Friends", 9, 22, [["Early", 400], ["Regular", 550]], 250, [15, 13, 7]],
  ["Sunset House", 11, 18, [["Entry", 200]], 80, []],                               // no picture: text-only card
  ["Basement Grooves", 13, 23, [["Entry", 300], ["VIP", 800]], 150, [6, 12]],
  ["Pool Party Finale", 16, 16, [["Entry", 0]], 100, [14]],                          // free
  ["Retro 2000s Night", 18, 22, [["Entry", 350]], 180, [3, 8]],
  ["Desert Lights", 21, 20, [["Early", 450], ["Regular", 600]], 220, [11, 16, 5]],
  ["Winter Warm-Up", 25, 21, [["Entry", 250]], 140, [12, 2]],
];

// The session value is ours to choose (as in door join); the server keeps only its hash.
const doorToken = token();
const join = await call("POST", "/api/invites/consume", { token: inviteToken, session: doorToken }, null, { "content-type": "application/json" });
if (join.status !== 200) { console.error(`Invitation not accepted: HTTP ${join.status} ${JSON.stringify(join.body)}`); process.exit(1); }
const doorSess = await withCsrf(doorToken);

const made = [];
for (const [i, [name, days, hour, types, capacity, pics]] of PARTIES.entries()) {
  const ownerToken = token();
  const p = must(await call("POST", "/api/test/party", { session: ownerToken, name: name.slice(0, 60) }, doorSess), `test party ${name}`);
  const os = await withCsrf(ownerToken);
  must(await call("POST", "/api/party/details", {
    name, time_zone: "Africa/Cairo", starts_at_local: local(days, hour), ends_at_local: local(days + 1, 4), capacity,
    description: "Demo party on staging (test data).",
    rules: WITH_RULES.has(i) ? RULES : null, cancellation_policy: WITH_CANCEL.has(i) ? CANCEL : null,
  }, os), `details ${name}`);
  for (const [tname, price] of types) must(await call("POST", "/api/tickets/types", { op: randomUUID(), name: tname, price }, os), `type ${tname}`);
  for (const n of pics) {
    const fd = new FormData();
    fd.set("op", randomUUID());
    fd.set("file", new Blob([readFileSync(new URL(`../public/img/hero/hero-${n}.jpg`, import.meta.url))], { type: "image/jpeg" }), `hero-${n}.jpg`);
    must(await call("POST", "/api/party/flyers", fd, os), `picture hero-${n} for ${name}`);
  }
  made.push({ id: p.party_id, name: name.slice(0, 40), pictures: pics.length });
  console.log(`made ${p.party_id}  ${name.slice(0, 50)}  (${pics.length} pictures)`);
}
console.log(`\n${made.length} demo parties on ${base}`);
