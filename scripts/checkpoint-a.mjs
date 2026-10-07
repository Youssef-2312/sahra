#!/usr/bin/env node
// Checkpoint A driver: joins as door staff with an invitation link, then runs the
// scan prototype against the live Worker and prints client-side latency.
// CPU time per request is read from Workers Logs (see docs/CHECKPOINT-A.md).
//
//   node scripts/checkpoint-a.mjs --invite "https://sahra.<you>.workers.dev/join#t=..." [--scans 50]

import { createHmac, randomBytes, randomUUID } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
if (!args.invite) { console.error("--invite <door invitation link> required"); process.exit(1); }
const link = new URL(args.invite);
const base = link.origin;
const token = /t=([A-Za-z0-9_-]{43})/.exec(link.hash)?.[1];
if (!token) { console.error("invitation link has no #t= token"); process.exit(1); }
const scans = Number(args.scans ?? 50);

const sessionToken = randomBytes(32).toString("base64url");
const csrf = createHmac("sha256", Buffer.from(sessionToken, "base64url")).update("sahra-csrf-v1").digest("base64url");
const headers = { origin: base, "content-type": "application/json", cookie: `__Host-sahra_s=${sessionToken}`, "x-sahra-csrf": csrf };

async function post(path, body, h = headers) {
  const t0 = performance.now();
  const r = await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  const ms = performance.now() - t0;
  return { status: r.status, body: await r.json().catch(() => ({})), ms };
}

const join = await post("/api/invites/consume", { token, session: sessionToken }, { origin: base, "content-type": "application/json" });
if (join.status !== 200) { console.error("join failed", join); process.exit(1); }
console.log(`joined as ${join.body.staff_name}`);

const lat = { ticket: [], admit: [], used: [], invalid: [] };
const verdicts = {};
for (let i = 0; i < scans; i++) {
  const t = await post("/api/proto/ticket", {});
  lat.ticket.push(t.ms);
  if (!t.body.qr) { console.error("ticket failed", t); process.exit(1); }
  const a = await post("/api/proto/scan", { scan_id: randomUUID(), qr: t.body.qr });
  lat.admit.push(a.ms);
  verdicts[a.body.verdict] = (verdicts[a.body.verdict] ?? 0) + 1;
  const u = await post("/api/proto/scan", { scan_id: randomUUID(), qr: t.body.qr });
  lat.used.push(u.ms);
  verdicts["second:" + u.body.verdict] = (verdicts["second:" + u.body.verdict] ?? 0) + 1;
  const bad = await post("/api/proto/scan", { scan_id: randomUUID(), qr: t.body.qr.slice(0, -1) + (t.body.qr.endsWith("0") ? "1" : "0") });
  lat.invalid.push(bad.ms);
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0); };
console.log("verdicts:", verdicts);
for (const [k, xs] of Object.entries(lat)) console.log(`${k}: n=${xs.length} p50=${pct(xs, 0.5)} ms p95=${pct(xs, 0.95)} ms (client round trip, includes your network)`);
console.log(`\nNow open Workers Logs and run the queries in docs/CHECKPOINT-A.md. Session expires in 16 h; sign it out by revoking the invitation.`);
