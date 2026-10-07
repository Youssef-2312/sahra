#!/usr/bin/env node
// Live checks on STAGING (Checkpoint B). Joins as door staff with an invitation
// link, then exercises the real scan path and prints PASS/FAIL per check plus
// client round-trip latency. CPU per endpoint: setup.bat step 12 (it runs this).
//
//   node scripts/live-check.mjs --invite "https://sahra-staging.<you>.workers.dev/join#t=..." \
//     [--scans 100] [--races 30] [--join-rounds 30]
//
// Before running: open admission for the party on the staging dashboard.
//  1. Join race: 8 simultaneous joins on the given invitation -> exactly one session.
//  2. Join rounds: for each round, a new test invitation (staging-only endpoint) and
//     8 simultaneous joins -> exactly one session each (these sessions are the "phones").
//  3. Sequential: per ticket admit, same-id retry (stored outcome), second scan (used),
//     forged code (stop).
//  4. Races: N tickets, each scanned by 8 different phones at the same moment -> one admit.

import { createHash, randomBytes, randomUUID } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
if (!args.invite) { console.error("--invite <door invitation link from STAGING> required"); process.exit(1); }
const link = new URL(args.invite);
// SAHRA_LIVE_CHECK_LOCAL=1 allows a local `wrangler dev` rehearsal; nothing else bypasses this.
if (!link.hostname.startsWith("sahra-staging.") && !(process.env.SAHRA_LIVE_CHECK_LOCAL === "1" && ["127.0.0.1", "localhost"].includes(link.hostname))) {
  console.error(`Refusing to run against ${link.hostname}: live checks run only on sahra-staging.`);
  process.exit(1);
}
const base = link.origin;
const firstToken = /t=([A-Za-z0-9_-]{43})/.exec(link.hash)?.[1];
if (!firstToken) { console.error("invitation link has no #t= token"); process.exit(1); }
const SCANS = Number(args.scans ?? 100);
const RACES = Number(args.races ?? 30);
const ROUNDS = Number(args["join-rounds"] ?? 30);
const PHONES = 8;

// Must match src/lib/crypto.ts csrfFor.
const csrfFor = (s) => createHash("sha256").update(Buffer.concat([Buffer.from("sahra-csrf-v2|"), Buffer.from(s, "base64url")])).digest("base64url");
const headersFor = (s) => ({ origin: base, "content-type": "application/json", cookie: `__Host-sahra_s=${s}`, "x-sahra-csrf": csrfFor(s) });
const lat = {};
// Network errors (your connection, not the server's answer) are retried with the
// SAME request body, like a real scanner: same scan id, same join value.
let networkRetries = 0;
async function call(method, path, body, headers, label) {
  const delays = [1, 2, 4, 8, 16];
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    try {
      const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      (lat[label ?? path] ??= []).push(performance.now() - t0);
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch (e) {
      if (attempt >= delays.length) throw e;
      networkRetries++;
      console.log(`  network error on ${path} (${e.cause?.code ?? e.name}); retrying in ${delays[attempt]} s with the same request`);
      await new Promise((ok) => setTimeout(ok, delays[attempt] * 1000));
    }
  }
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

async function joinRace(token) {
  const values = Array.from({ length: PHONES }, () => randomBytes(32).toString("base64url"));
  const rs = await Promise.all(values.map((s) => call("POST", "/api/invites/consume", { token, session: s }, { origin: base, "content-type": "application/json" }, "join")));
  const winners = values.filter((_, i) => rs[i].status === 200);
  return { winners, statuses: rs.map((r) => r.status) };
}

// 1. Join race on the given invitation.
const first = await joinRace(firstToken);
check(`join race: ${PHONES} simultaneous joins, exactly one session`, first.winners.length === 1, `statuses=${JSON.stringify(first.statuses)}`);
if (first.winners.length !== 1) process.exit(1);
const main = first.winners[0];
const H = headersFor(main);
const retry = await call("POST", "/api/invites/consume", { token: firstToken, session: main }, { origin: base, "content-type": "application/json" }, "join");
check("join retry with the same browser value succeeds again", retry.status === 200);

const adm = await call("GET", "/api/admission", undefined, H, "admission");
if (!adm.body.open) {
  console.error("\nAdmission is not open for this party. Open it on the staging dashboard (Open admission), then run again with a NEW invitation.");
  process.exit(1);
}

// 2. Join rounds: each gives one more phone.
const phones = [main];
let roundsOk = 0;
for (let i = 0; i < ROUNDS; i++) {
  const inv = await call("POST", "/api/test/door-invite", {}, H, "test-invite");
  if (inv.status !== 200) { console.error("test invitation failed", inv); process.exit(1); }
  const r = await joinRace(inv.body.token);
  if (r.winners.length === 1) { roundsOk++; phones.push(r.winners[0]); }
}
check(`join rounds: ${ROUNDS} invitations x ${PHONES} simultaneous joins, exactly one session each`, roundsOk === ROUNDS, `${roundsOk}/${ROUNDS}`);

async function tickets(n) {
  const out = [];
  while (out.length < n) {
    const r = await call("POST", "/api/test/tickets", { count: Math.min(20, n - out.length) }, H, "test-tickets");
    if (r.status !== 200) { console.error("tickets failed", r); process.exit(1); }
    out.push(...r.body.tickets);
  }
  return out;
}
const scanOnce = (sess, qr, scanId = randomUUID()) => call("POST", "/api/scan", { scan_id: scanId, qr }, headersFor(sess), "scan").then((r) => r.body);

// 3. Sequential checks.
const v = {};
const count = (k) => { v[k] = (v[k] ?? 0) + 1; };
for (const t of await tickets(SCANS)) {
  const id = randomUUID();
  count("first:" + (await scanOnce(main, t.qr, id)).verdict);
  count("retry_same_id:" + (await scanOnce(main, t.qr, id)).verdict);
  count("second:" + (await scanOnce(phones[1 % phones.length], t.qr)).verdict);
  count("forged:" + (await scanOnce(main, t.qr.slice(0, -1) + (t.qr.endsWith("0") ? "1" : "0"))).verdict);
}
check("every first scan admitted", v["first:admit"] === SCANS, JSON.stringify(v));
check("retry with the same scan id returns the stored outcome (admit, no second redemption)", v["retry_same_id:admit"] === SCANS);
check("every second scan says used", v["second:used"] === SCANS);
check("every forged code stopped", v["forged:stop"] === SCANS);

// 4. Races across different phones.
let raceOk = 0;
for (const t of await tickets(RACES)) {
  const who = Array.from({ length: PHONES }, (_, i) => phones[(i + 1) % phones.length]);
  const rs = await Promise.all(who.map((p) => scanOnce(p, t.qr)));
  const admits = rs.filter((r) => r.verdict === "admit").length;
  const used = rs.filter((r) => r.verdict === "used").length;
  if (admits === 1 && used === PHONES - 1) raceOk++;
}
check(`scan race: ${PHONES} phones scan one ticket at the same moment, exactly one admit (${RACES} tickets)`, raceOk === RACES, `${raceOk}/${RACES}`);

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(0); };
console.log("\nclient round trip (includes your network):");
for (const [k, xs] of Object.entries(lat)) console.log(`  ${k.padEnd(12)} n=${String(xs.length).padStart(4)}  p50=${pct(xs, 0.5)} ms  p95=${pct(xs, 0.95)} ms  p99=${pct(xs, 0.99)} ms`);
if (networkRetries) console.log(`\nNetwork retries (client side): ${networkRetries}`);
console.log(`\n${failures === 0 ? "All checks passed." : failures + " check(s) FAILED."} Then run setup.bat step 11 (ledger check). Revoke the invitation on the dashboard.`);
process.exit(failures === 0 ? 0 : 1);
