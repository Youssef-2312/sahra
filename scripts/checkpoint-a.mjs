#!/usr/bin/env node
// Checkpoint A driver (STAGING ONLY). Runs live concurrency tests and the scan
// prototype against sahra-staging and prints client-side results. CPU time per
// request is read from Workers Logs (see docs/SETUP.md, part C).
//
//   node scripts/checkpoint-a.mjs --invite "https://sahra-staging.<you>.workers.dev/join#t=..." [--scans 50] [--phones 8]
//
// 1. Join race: --phones browsers press Join on the same invitation at the same
//    moment. Expected: exactly one succeeds.
// 2. Sequential scans: per ticket, admit, then a second scan (used), then a forged code (stop).
// 3. Scan race: --phones scanners scan the same ticket at the same moment, each with
//    its own scan id. Expected: exactly one admit per ticket.

import { createHmac, randomBytes, randomUUID } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
if (!args.invite) { console.error("--invite <door invitation link from STAGING> required"); process.exit(1); }
const link = new URL(args.invite);
if (!link.hostname.startsWith("sahra-staging.")) {
  console.error(`Refusing to run against ${link.hostname}: Checkpoint A runs only on sahra-staging.`);
  process.exit(1);
}
const base = link.origin;
const token = /t=([A-Za-z0-9_-]{43})/.exec(link.hash)?.[1];
if (!token) { console.error("invitation link has no #t= token"); process.exit(1); }
const scans = Number(args.scans ?? 50);
const phones = Number(args.phones ?? 8);

const csrfFor = (s) => createHmac("sha256", Buffer.from(s, "base64url")).update("sahra-csrf-v1").digest("base64url");

async function post(path, body, headers) {
  const t0 = performance.now();
  const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), ms: performance.now() - t0 };
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// 1. Join race
const candidates = Array.from({ length: phones }, () => randomBytes(32).toString("base64url"));
const joins = await Promise.all(candidates.map((s) =>
  post("/api/invites/consume", { token, session: s }, { origin: base, "content-type": "application/json" })));
const winners = joins.map((j, i) => [j, candidates[i]]).filter(([j]) => j.status === 200);
check(`join race: ${phones} simultaneous joins, exactly one session`, winners.length === 1,
  `statuses=${JSON.stringify(joins.map((j) => j.status))}`);
if (winners.length !== 1) process.exit(1);
const session = winners[0][1];
const headers = { origin: base, "content-type": "application/json", cookie: `__Host-sahra_s=${session}`, "x-sahra-csrf": csrfFor(session) };
const retry = await post("/api/invites/consume", { token, session }, { origin: base, "content-type": "application/json" });
check("join retry with the same browser value succeeds again", retry.status === 200);

// 2. Sequential scans
const lat = { ticket: [], admit: [], used: [], invalid: [], race: [] };
const verdicts = {};
const count = (k) => { verdicts[k] = (verdicts[k] ?? 0) + 1; };
for (let i = 0; i < scans; i++) {
  const t = await post("/api/proto/ticket", {}, headers);
  lat.ticket.push(t.ms);
  if (!t.body.qr) { console.error("ticket failed", t); process.exit(1); }
  const scanId = randomUUID();
  const a = await post("/api/proto/scan", { scan_id: scanId, qr: t.body.qr }, headers);
  lat.admit.push(a.ms); count("first:" + a.body.verdict);
  const again = await post("/api/proto/scan", { scan_id: scanId, qr: t.body.qr }, headers);
  count("retry_same_id:" + again.body.verdict);
  const u = await post("/api/proto/scan", { scan_id: randomUUID(), qr: t.body.qr }, headers);
  lat.used.push(u.ms); count("second:" + u.body.verdict);
  const forged = t.body.qr.slice(0, -1) + (t.body.qr.endsWith("0") ? "1" : "0");
  const bad = await post("/api/proto/scan", { scan_id: randomUUID(), qr: forged }, headers);
  lat.invalid.push(bad.ms); count("forged:" + bad.body.verdict);
}
check("every first scan admitted", verdicts["first:admit"] === scans);
check("retry with the same scan id returns the stored outcome", verdicts["retry_same_id:admit"] === scans);
check("every second scan says used", verdicts["second:used"] === scans);
check("every forged code stopped", verdicts["forged:stop"] === scans);

// 3. Scan race
let raceOk = 0;
const races = Math.min(20, scans);
for (let i = 0; i < races; i++) {
  const t = await post("/api/proto/ticket", {}, headers);
  const rs = await Promise.all(Array.from({ length: phones }, () => post("/api/proto/scan", { scan_id: randomUUID(), qr: t.body.qr }, headers)));
  rs.forEach((r) => lat.race.push(r.ms));
  if (rs.filter((r) => r.body.verdict === "admit").length === 1) raceOk++;
}
check(`scan race: ${phones} simultaneous scans per ticket, exactly one admit (${races} tickets)`, raceOk === races, `${raceOk}/${races}`);

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0); };
console.log("\nverdicts:", verdicts);
for (const [k, xs] of Object.entries(lat)) console.log(`${k}: n=${xs.length} p50=${pct(xs, 0.5)} ms p95=${pct(xs, 0.95)} ms (client round trip, includes your network)`);
console.log(`\n${failures === 0 ? "All checks passed." : failures + " check(s) FAILED."} Now read CPU time in Workers Logs (docs/SETUP.md part C), then revoke the invitation.`);
process.exit(failures === 0 ? 0 : 1);
