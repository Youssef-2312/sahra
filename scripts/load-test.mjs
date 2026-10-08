#!/usr/bin/env node
// Peak-load test on STAGING (owner decision, docs/DECISIONS.md "Load test").
// Run it on a day with no ticket sales: it shares the account's daily allowances
// with production.
//
//   node scripts/load-test.mjs --invite "https://sahra-staging.<you>.workers.dev/join#t=..."     (estimate only)
//   node scripts/load-test.mjs --invite "<link>" --yes [--tail]                                  (run it)
//
// The invitation is a door invitation (1 hour) of any staging party; its session
// only creates the test parties. Defaults are the owner's numbers:
//   1. Steady: 4,000 tickets, each admitted once within 30 minutes, 10 parties x 4
//      scanners (about 2.2 admissions/s), plus repeat scans (a guest scanned twice)
//      and denied scans (wrong party, QR not sent yet). Each scanner is one phone:
//      one session, one scan at a time with think time, one retry with the SAME
//      scan id on a network error.
//   2. Burst: 8 scans/s for 5 minutes across the 40 scanners: new admissions,
//      repeat scans, same-ID retries and denied scans.
// Before anything is written it estimates requests and rows from the per-request
// costs measured locally (test/loadtest.test.ts) and refuses to start past 50% of
// the daily limits (100,000 rows written, 5,000,000 rows read, 100,000 Worker
// requests; account-wide, main + ledger). --yes is required to start. While it
// runs it keeps a running count and stops early (finishing scans in flight) before
// that budget is passed. Ctrl+C also stops it gracefully.
// At the end: every ticket admitted exactly once (each scan's verdict, then
// /api/test/ledger-check per party), cleanup (door access revoked, admission
// paused, test owner sessions ended), and a report: client latency p50/p95/p99,
// errors, CPU per endpoint (with --tail: `wrangler tail`, needs CLOUDFLARE_API_TOKEN
// with Workers Tail Read) and rows read/written (from the request log lines when
// collected, otherwise estimated; the report says which).
//
// Options (defaults in brackets): --parties [10] --scanners [4] (per party)
//   --tickets [4000] --minutes [30] --repeat-share [0.05] --denied-share [0.03]
//   --burst-rate [8] --burst-seconds [300] --burst-mix [new:0.5,repeat:0.25,retry:0.15,denied:0.1]
//   --phase [all|steady|burst] --tail (live CPU + rows) --log-file <wrangler dev output> (local rehearsal)
//   --already-written N --already-read N --already-requests N (today's usage from the dashboard)
//   --staging-table-rows [1000] (rows in parties+staff+invites on staging; each change-log flush reads them)
//   --staging-ledger-rows [10000] (rows in the staging ledger's change log before the run; the ledger check reads it)
//   With --tail these two are measured after the first join (one join + one read-only
//   ledger check) and the estimate is checked again before anything else is written.
//
// Local rehearsal (nothing reaches Cloudflare): SAHRA_LIVE_CHECK_LOCAL=1 with an
// invitation link on 127.0.0.1/localhost from `wrangler dev --env staging` (see
// docs/DECISIONS.md, workstream H).

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pct, perEndpoint, rowTotals, startRequestLog } from "./lib/req-log.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
  return acc;
}, []));
function fail(m) { console.error(m); process.exit(1); }
const num = (k, d) => {
  const v = args[k] === undefined ? d : Number(args[k]);
  if (!Number.isFinite(v) || v < 0) fail(`--${k} must be a number`);
  return v;
};

if (!args.invite) fail("--invite <door invitation link from STAGING> required");
const link = new URL(args.invite);
const LOCAL = process.env.SAHRA_LIVE_CHECK_LOCAL === "1" && ["127.0.0.1", "localhost"].includes(link.hostname);
// SAHRA_LIVE_CHECK_LOCAL=1 allows a local `wrangler dev` rehearsal; nothing else bypasses this.
if (!link.hostname.startsWith("sahra-staging.") && !LOCAL) fail(`Refusing to run against ${link.hostname}: load tests run only on sahra-staging.`);
const base = link.origin;
const inviteToken = /t=([A-Za-z0-9_-]{43})/.exec(link.hash)?.[1];
if (!inviteToken) fail("invitation link has no #t= token");

const P = {
  parties: num("parties", 10), scanners: num("scanners", 4), tickets: num("tickets", 4000), minutes: num("minutes", 30),
  repeatShare: num("repeat-share", 0.05), deniedShare: num("denied-share", 0.03),
  burstRate: num("burst-rate", 8), burstSeconds: num("burst-seconds", 300),
  phase: args.phase ?? "all", tableRows: num("staging-table-rows", 1000), ledgerRows: num("staging-ledger-rows", 10000),
};
if (!["all", "steady", "burst"].includes(P.phase)) fail("--phase must be all, steady or burst");
if (P.parties < 1 || P.scanners < 1 || !Number.isInteger(P.parties) || !Number.isInteger(P.scanners)) fail("--parties and --scanners must be whole numbers >= 1");
const MIX = { new: 0.5, repeat: 0.25, retry: 0.15, denied: 0.1 };
if (args["burst-mix"]) {
  for (const kv of String(args["burst-mix"]).split(",")) {
    const [k, v] = kv.split(":");
    if (!(k in MIX) || !Number.isFinite(Number(v))) fail("--burst-mix like new:0.5,repeat:0.25,retry:0.15,denied:0.1");
    MIX[k] = Number(v);
  }
}
const mixSum = MIX.new + MIX.repeat + MIX.retry + MIX.denied;
for (const k of Object.keys(MIX)) MIX[k] /= mixSum;
const STEADY = P.phase !== "burst";
const BURST = P.phase !== "steady";

// ---------------------------------------------------------------- estimate

// Rows per request [main read, main written, ledger read, ledger written], measured
// locally (workerd + local D1, test/loadtest.test.ts "rows per request"). Reads of
// requests that flush the change log grow with the parties/staff/invites tables
// (Db.unlogged reads them whole); --staging-table-rows adds that per flush.
const COST = {
  join: [21, 7, 0, 1, true],
  test_party: [34, 15, 0, 3, true],
  door_invite: [24, 11, 0, 2, true],
  tickets_20: [153, 80, 0, 20, true],
  tickets_2: [70, 8, 0, 2, true],
  admission_get: [4, 0, 1, 0, false],
  scan_admit: [18, 2, 2, 1, false],
  scan_used: [14, 1, 1, 0, false],
  scan_retry: [14, 0, 2, 0, false],
  scan_not_released: [13, 1, 1, 0, false],
  scan_wrong_party: [8, 0, 1, 0, false],
  pause: [24, 3, 2, 2, true],
  logout: [4, 1, 0, 0, false],
};
const LIMITS = { written: 100_000, read: 5_000_000, requests: 100_000 };
const ALREADY = { written: num("already-written", 0), read: num("already-read", 0), requests: num("already-requests", 0) };
const BUDGET = { written: LIMITS.written / 2 - ALREADY.written, read: LIMITS.read / 2 - ALREADY.read, requests: LIMITS.requests / 2 - ALREADY.requests };
const READ_MARGIN = 1.5;
const RETRY_MARGIN = 1.05;

function plan() {
  const perParty = (n) => Math.ceil(n / P.parties);
  const steady = STEADY ? { admit: P.tickets, used: Math.round(P.tickets * P.repeatShare), denied: Math.round(P.tickets * P.deniedShare) } : { admit: 0, used: 0, denied: 0 };
  const burstScans = BURST ? Math.round(P.burstRate * P.burstSeconds) : 0;
  const burst = { admit: Math.round(burstScans * MIX.new), used: Math.round(burstScans * MIX.repeat), retry: Math.round(burstScans * MIX.retry) };
  burst.denied = burstScans - burst.admit - burst.used - burst.retry;
  const tpp = perParty(steady.admit) + perParty(burst.admit);
  return { steady, burst, burstScans, ticketsPerParty: tpp, ticketReqsPerParty: Math.ceil(tpp / 20), steadyPerParty: perParty(steady.admit), burstPerParty: perParty(burst.admit) };
}

function estimate(pl) {
  const n = {};
  const add = (k, times) => { n[k] = (n[k] ?? 0) + times; };
  add("join", 1 + P.parties * P.scanners);
  add("test_party", P.parties);
  add("door_invite", P.parties * P.scanners);
  add("tickets_20", P.parties * pl.ticketReqsPerParty);
  add("tickets_2", P.parties);
  add("admission_get", P.parties);
  add("scan_admit", (pl.steady.admit + pl.burst.admit) * RETRY_MARGIN);
  add("scan_used", (pl.steady.used + pl.burst.used) * RETRY_MARGIN);
  add("scan_retry", pl.burst.retry);
  add("scan_not_released", Math.ceil((pl.steady.denied + pl.burst.denied) / 2) * RETRY_MARGIN);
  add("scan_wrong_party", Math.floor((pl.steady.denied + pl.burst.denied) / 2) * RETRY_MARGIN);
  add("pause", P.parties);
  add("logout", P.parties + 1);
  const t = { requests: 0, read: 0, written: 0, main_read: 0, main_written: 0, ledger_read: 0, ledger_written: 0 };
  for (const [k, times] of Object.entries(n)) {
    const [r, w, lr, lw, flush] = COST[k];
    t.requests += times;
    t.main_read += times * (r + (flush ? P.tableRows : 0));
    t.main_written += times * w;
    t.ledger_read += times * lr;
    t.ledger_written += times * lw;
  }
  // Per party: the ledger check reads the scans and tickets (measured locally: about
  // all scans + all tickets + 5 per ticket of the party) and the WHOLE ledger change
  // log twice (no party index there). The cleanup revokes one invitation and ends one
  // session per scanner (+ audit, change log) and reads the sessions/invites tables.
  const scansAll = pl.steady.admit + pl.steady.used + pl.steady.denied + pl.burstScans;
  const ticketsAll = P.parties * (pl.ticketsPerParty + 2);
  const changeLogAll = P.ledgerRows + ticketsAll + pl.steady.admit + pl.burst.admit + P.parties * (3 + 3 * P.scanners);
  t.requests += P.parties * 3;
  t.main_read += P.parties * (scansAll + ticketsAll + 5 * pl.ticketsPerParty + 300 + P.tableRows);
  t.ledger_read += P.parties * 2 * changeLogAll;
  t.main_written += P.parties * (5 + 3 * P.scanners);
  t.ledger_written += P.parties * (1 + P.scanners);
  t.main_read = Math.round(t.main_read * READ_MARGIN);
  t.ledger_read = Math.round(t.ledger_read * READ_MARGIN);
  t.requests = Math.round(t.requests);
  t.main_written = Math.round(t.main_written);
  t.ledger_written = Math.round(t.ledger_written);
  t.read = t.main_read + t.ledger_read;
  t.written = t.main_written + t.ledger_written;
  return { counts: n, total: t };
}

const PL = plan();
let EST = estimate(PL);
const fmt = (x) => Math.round(x).toLocaleString("en-US");
console.log(`Load test against ${base}${LOCAL ? "  (LOCAL rehearsal: numbers are local, not Cloudflare's)" : ""}`);
console.log(`Plan: ${P.parties} parties x ${P.scanners} scanners.`);
if (STEADY) console.log(`  Steady: ${fmt(PL.steady.admit)} admissions in ${P.minutes} min (+ ${fmt(PL.steady.used)} repeat scans, ${fmt(PL.steady.denied)} denied), about ${((PL.steady.admit + PL.steady.used + PL.steady.denied) / (P.minutes * 60)).toFixed(2)} scans/s.`);
if (BURST) console.log(`  Burst: ${P.burstRate} scans/s for ${P.burstSeconds} s = ${fmt(PL.burstScans)} scans (${fmt(PL.burst.admit)} new admissions, ${fmt(PL.burst.used)} repeats, ${fmt(PL.burst.retry)} same-ID retries, ${fmt(PL.burst.denied)} denied).`);
console.log(`  Tickets created: ${fmt(PL.ticketsPerParty * P.parties)} + ${2 * P.parties} not released.`);
console.log(`\nEstimate (per-request rows measured locally; reads x1.5 margin; staging tables assumed ${fmt(P.tableRows)} rows, ledger change log ${fmt(P.ledgerRows)}):`);
console.log(`  Worker requests  ${fmt(EST.total.requests).padStart(10)}   budget ${fmt(BUDGET.requests)} (50% of ${fmt(LIMITS.requests)} minus ${fmt(ALREADY.requests)} already used today)`);
console.log(`  D1 rows written  ${fmt(EST.total.written).padStart(10)}   (main ${fmt(EST.total.main_written)} + ledger ${fmt(EST.total.ledger_written)})   budget ${fmt(BUDGET.written)}`);
console.log(`  D1 rows read     ${fmt(EST.total.read).padStart(10)}   (main ${fmt(EST.total.main_read)} + ledger ${fmt(EST.total.ledger_read)})   budget ${fmt(BUDGET.read)}`);
const overBudget = () => ["requests", "written", "read"].filter((k) => EST.total[k] > BUDGET[k]);
const over = overBudget();
if (over.length) fail(`\nRefusing to start: the estimate passes 50% of the daily limit for ${over.join(", ")}. Lower --tickets or the burst, or run another day.`);
if (args.yes !== "true") {
  console.log("\nNothing was sent. Run on a day with no ticket sales; add --yes to start.");
  process.exit(0);
}

// ------------------------------------------------------------------- client

// Must match src/lib/crypto.ts csrfFor.
const csrfFor = (s) => createHash("sha256").update(Buffer.concat([Buffer.from("sahra-csrf-v2|"), Buffer.from(s, "base64url")])).digest("base64url");
const headersFor = (s) => ({ origin: base, "content-type": "application/json", cookie: `__Host-sahra_s=${s}`, "x-sahra-csrf": csrfFor(s) });
const newSession = () => randomBytes(32).toString("base64url");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, Math.max(0, ms)));

const lat = {};
const sent = { requests: 0, byKind: {} };
const errors = { http: 0, network: 0, unexpected: 0, cant_verify: 0, recording: 0, examples: [] };
let networkRetries = 0;
function noteError(kind, detail) {
  errors[kind]++;
  if (errors.examples.length < 30) errors.examples.push({ kind, ...detail });
}

/**
 * One request. A network error (no answer) is retried ONCE with the same body,
 * like a phone (scans keep their scan id); `retries` raises that for setup calls.
 */
async function call(method, path, body, headers, label, costKey, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    sent.requests++;
    if (costKey) sent.byKind[costKey] = (sent.byKind[costKey] ?? 0) + 1;
    try {
      const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const b = await r.json().catch(() => ({}));
      const ms = performance.now() - t0;
      (lat[label] ??= []).push(ms);
      if (label.startsWith("scan ")) (lat["scan (all kinds)"] ??= []).push(ms);
      return { status: r.status, body: b };
    } catch (e) {
      if (attempt >= retries) return { status: 0, body: {}, net: e.cause?.code ?? e.name };
      networkRetries++;
      await sleep(1000 * (attempt + 1));
    }
  }
}

// ------------------------------------------------------------ running budget

let stopping = false;
let stopReason = null;
function stop(reason) {
  if (!stopping) { stopping = true; stopReason = reason; console.log(`\nStopping early: ${reason}. Finishing scans in flight...`); }
}
process.on("SIGINT", () => stop("Ctrl+C"));

function spentEstimate() {
  const t = { requests: sent.requests, read: 0, written: 0 };
  for (const [k, times] of Object.entries(sent.byKind)) {
    const c = COST[k];
    if (!c) continue;
    t.read += times * (c[0] + c[2] + (c[4] ? P.tableRows : 0)) * READ_MARGIN;
    t.written += times * (c[1] + c[3]);
  }
  return t;
}
let reqLog = null;
function spentNow() {
  const e = spentEstimate();
  if (!reqLog) return e;
  const m = rowTotals(reqLog.requests);
  return { requests: Math.max(e.requests, m.requests), read: Math.max(e.read, m.rows_read + m.ledger_rows_read), written: Math.max(e.written, m.rows_written + m.ledger_rows_written) };
}
// Kept back for the end: ledger checks and cleanup.
const RESERVE = { requests: P.parties * 6 + 10, written: P.parties * (10 + 4 * P.scanners), read: Math.round((EST.total.main_read + EST.total.ledger_read) * 0.3) };
function checkBudget() {
  const s = spentNow();
  for (const k of ["requests", "written", "read"]) if (s[k] + RESERVE[k] > BUDGET[k]) stop(`the running count of ${k} (${fmt(s[k])}) is near the budget (${fmt(BUDGET[k])})`);
}

// -------------------------------------------------------------------- setup

if (args.tail === "true" && !LOCAL) {
  reqLog = startRequestLog({ tail: true });
  console.log("\nConnecting to the staging request stream (wrangler tail)...");
  await sleep(8000);
  if (reqLog.child.exitCode !== null) fail("wrangler tail stopped:\n" + reqLog.error());
} else if (args["log-file"]) {
  reqLog = startRequestLog({ file: args["log-file"] });
}

const started = new Date();
const boot = newSession();
const j0 = await call("POST", "/api/invites/consume", { token: inviteToken, session: boot }, { origin: base, "content-type": "application/json" }, "join", "join", 3);
if (j0.status !== 200) fail(`Joining with the invitation failed (HTTP ${j0.status} ${JSON.stringify(j0.body)}): it needs a NEW, unused door invitation.`);
const H0 = headersFor(boot);

// Calibration (only when the request log is collected): the join just made reads the
// parties/staff/invites tables in full (change-log flush); a read-only ledger check
// of the invitation's party reads the ledger's change log twice. Re-estimate with
// the measured sizes before anything else is written.
if (reqLog) {
  await call("GET", "/api/test/ledger-check", undefined, H0, "ledger-check", null, 3);
  const t1 = performance.now();
  const seen = (route) => reqLog.requests.find((r) => r.route === route);
  while (performance.now() - t1 < 30000 && !(seen("POST /api/invites/consume") && seen("GET /api/test/ledger-check"))) await sleep(500);
  const j = seen("POST /api/invites/consume");
  const lc = seen("GET /api/test/ledger-check");
  if (j && lc) {
    P.tableRows = j.rows_read;
    P.ledgerRows = Math.ceil(lc.ledger_rows_read / 2);
    EST = estimate(PL);
    console.log(`\nMeasured: a change-log flush reads ${fmt(P.tableRows)} rows; the ledger's change log has about ${fmt(P.ledgerRows)} rows.`);
    console.log(`  Estimate now: requests ${fmt(EST.total.requests)}, rows written ${fmt(EST.total.written)}, rows read ${fmt(EST.total.read)}.`);
    const o = overBudget();
    if (o.length) {
      await call("POST", "/api/auth/logout", {}, H0, "cleanup", "logout", 3);
      reqLog.stop();
      fail(`Refusing to continue: with the measured sizes the estimate passes 50% of the daily limit for ${o.join(", ")} (only one join was written).`);
    }
  } else {
    console.log("\nCould not see the first requests in the request log within 30 s; keeping the assumed table sizes.");
  }
}

/** @type {{ id: string, owner: string, H: object, tickets: object[], burst: object[], unreleased: object[], admitted: object[], scanners: object[] }[]} */
const parties = [];
console.log(`\nSetup: ${P.parties} test parties, ${P.scanners} scanners each, tickets...`);
for (let i = 0; i < P.parties; i++) {
  const owner = newSession();
  const r = await call("POST", "/api/test/party", { session: owner, name: `Load test ${started.toISOString().slice(0, 16)} #${i + 1}` }, H0, "test-party", "test_party", 3);
  if (r.status === 404) fail("This deploy has no /api/test/party (deploy the branch with workstream H to staging first).");
  if (r.status !== 200) fail(`test party failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  const H = headersFor(owner);
  const party = { id: r.body.party_id, owner, H, tickets: [], burst: [], unreleased: [], admitted: [], scanners: [] };
  for (let s = 0; s < P.scanners; s++) {
    const inv = await call("POST", "/api/test/door-invite", {}, H, "test-invite", "door_invite", 3);
    if (inv.status !== 200) fail(`door invitation failed: HTTP ${inv.status}`);
    const sess = newSession();
    const j = await call("POST", "/api/invites/consume", { token: inv.body.token, session: sess }, { origin: base, "content-type": "application/json" }, "join", "join", 3);
    if (j.status !== 200) fail(`scanner join failed: HTTP ${j.status} ${JSON.stringify(j.body)}`);
    party.scanners.push({ name: `p${i + 1}s${s + 1}`, party, sess, H: headersFor(sess), last: null, queue: [], burstQueue: [] });
  }
  let lost = 0;
  const all = [];
  while (all.length < PL.ticketsPerParty) {
    const t = await call("POST", "/api/test/tickets", { count: Math.min(20, PL.ticketsPerParty - all.length) }, H, "test-tickets", "tickets_20", 3);
    // Created, but the change log answered pending: their codes are not returned; ask again.
    if (t.status === 503 && ++lost <= 5) continue;
    if (t.status !== 200) fail(`tickets failed: HTTP ${t.status} ${JSON.stringify(t.body)}`);
    all.push(...t.body.tickets.map((x) => ({ ...x, party, admits: new Set(), unresolved: false })));
  }
  const u = await call("POST", "/api/test/tickets", { count: 2, released: false }, H, "test-tickets", "tickets_2", 3);
  if (u.status !== 200) fail(`unreleased tickets failed: HTTP ${u.status}`);
  party.unreleased = u.body.tickets;
  party.tickets = all.slice(0, PL.steadyPerParty);
  party.burst = all.slice(PL.steadyPerParty);
  party.scanners.forEach((sc, k) => {
    sc.queue = party.tickets.filter((_, x) => x % P.scanners === k);
    sc.burstQueue = party.burst.filter((_, x) => x % P.scanners === k);
  });
  const adm = await call("GET", "/api/admission", undefined, H, "admission", "admission_get", 3);
  if (!adm.body.open) fail(`admission is not open for test party ${party.id}`);
  parties.push(party);
  console.log(`  party ${i + 1}/${P.parties}: ${party.id}, ${all.length} tickets${lost ? ` (${lost} request(s) answered pending)` : ""}`);
}
checkBudget();

// -------------------------------------------------------------------- scans

let scanCount = 0;
const recent = [];
const tally = {};
const count = (k) => { tally[k] = (tally[k] ?? 0) + 1; };
const violations = [];
const unresolved = [];
const phaseStats = {};

async function scan(sc, qr, scanId, cls, costKey) {
  if (++scanCount % 50 === 0) checkBudget();
  const r = await call("POST", "/api/scan", { scan_id: scanId, qr }, sc.H, `scan ${cls}`, costKey);
  // Stop when the Worker stops answering (quota used up, outage): half of the last 100 scans failed.
  recent.push(r.status === 200 ? 0 : 1);
  if (recent.length > 100) recent.shift();
  if (recent.length >= 50 && recent.reduce((a, b) => a + b, 0) >= 50) stop("half of the last 100 scans got no answer or an HTTP error");
  if (r.status === 0) { noteError("network", { scanner: sc.name, cls }); return { verdict: null, net: true }; }
  if (r.status !== 200) {
    noteError("http", { scanner: sc.name, cls, status: r.status, error: r.body?.error });
    if (r.body?.verdict === "admit") violations.push({ what: "green with an HTTP error", scanner: sc.name, status: r.status });
    return { verdict: null };
  }
  return r.body;
}

/** A first scan of a ticket: admit; "recording"/"cant_verify" are retried with the SAME scan id. */
async function admitNew(sc, t, phase) {
  const id = randomUUID();
  let v = await scan(sc, t.qr, id, "new", "scan_admit");
  for (let i = 0; i < 3 && (v.verdict === "recording" || v.verdict === "cant_verify" || v.net); i++) {
    if (v.verdict) noteError(v.verdict === "recording" ? "recording" : "cant_verify", { scanner: sc.name });
    await sleep(1000);
    v = await scan(sc, t.qr, id, "retry_same_id", "scan_retry");
  }
  sc.last = { qr: t.qr, id, verdict: v.verdict, t };
  if (v.verdict === "admit") {
    t.admits.add(id);
    if (t.admits.size > 1) violations.push({ what: "second admit for one ticket", ticket: t.id, scanner: sc.name });
    else { t.party.admitted.push(t); count(`${phase}:admitted`); }
  } else if (v.verdict === null) {
    t.unresolved = true;
    unresolved.push({ sc, t, id });
  } else {
    noteError("unexpected", { scanner: sc.name, expected: "admit", got: v.verdict, reason: v.reason });
  }
}

async function repeatScan(sc, phase) {
  const pool = sc.party.admitted;
  if (pool.length === 0) return deniedScan(sc, phase);
  const t = pool[Math.floor(Math.random() * pool.length)];
  const id = randomUUID();
  const v = await scan(sc, t.qr, id, "repeat", "scan_used");
  sc.last = { qr: t.qr, id, verdict: v.verdict, t };
  count(`${phase}:repeat`);
  if (v.verdict === "admit") violations.push({ what: "repeat scan admitted (QR used twice)", ticket: t.id, scanner: sc.name });
  else if (v.verdict !== "used" && v.verdict !== null) noteError("unexpected", { scanner: sc.name, expected: "used", got: v.verdict });
}

let deniedTurn = 0;
async function deniedScan(sc, phase) {
  const wrongParty = deniedTurn++ % 2 === 0 && parties.length > 1;
  const other = parties[(parties.indexOf(sc.party) + 1) % parties.length];
  const qr = wrongParty ? other.unreleased[0].qr : sc.party.unreleased[deniedTurn % 2].qr;
  const id = randomUUID();
  const v = await scan(sc, qr, id, wrongParty ? "wrong_party" : "not_released", wrongParty ? "scan_wrong_party" : "scan_not_released");
  sc.last = { qr, id, verdict: v.verdict, t: null };
  count(`${phase}:denied`);
  const expected = wrongParty ? "ticket is for another party" : "QR not sent yet";
  if (v.verdict === "admit") violations.push({ what: "denied scan admitted", scanner: sc.name });
  else if (v.verdict !== null && !(v.verdict === "stop" && v.reason === expected)) noteError("unexpected", { scanner: sc.name, expected: `stop: ${expected}`, got: v.verdict, reason: v.reason });
}

/** Same scan id again (a phone that did not see the answer): the stored outcome, never a second redemption. */
async function sameIdRetry(sc, phase) {
  const last = sc.last;
  if (!last || last.verdict === null) return repeatScan(sc, phase);
  const v = await scan(sc, last.qr, last.id, "retry_same_id", "scan_retry");
  count(`${phase}:retry`);
  if (v.verdict !== null && v.verdict !== last.verdict) noteError("unexpected", { scanner: sc.name, expected: `stored ${last.verdict}`, got: v.verdict });
}

/** Scanner k's whole-number share of `total` spread over n scanners (sums to total). */
const share = (total, k, n) => Math.floor(total / n) + (k < total % n ? 1 : 0);

function shuffle(xs) {
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
  return xs;
}

async function runPhase(name, buildActions, spacing, jitter) {
  const t0 = performance.now();
  const before = sent.requests;
  const allScanners = parties.flatMap((p) => p.scanners);
  const ticker = setInterval(() => {
    checkBudget();
    const el = (performance.now() - t0) / 1000;
    const done = Object.entries(tally).filter(([k]) => k.startsWith(name)).map(([k, v]) => `${k.split(":")[1]} ${v}`).join(", ");
    console.log(`  ${name} ${el.toFixed(0)} s: ${done}; errors ${errors.http + errors.network + errors.unexpected}`);
  }, 30000);
  await Promise.all(allScanners.map(async (sc, k) => {
    const actions = buildActions(sc, k, allScanners.length);
    const { first, every } = spacing(sc, k, actions.length);
    for (let i = 0; i < actions.length && !stopping; i++) {
      // Think time: evenly spread with +-jitter of one interval (steady); fixed slots (burst).
      await sleep(t0 + first + (i + jitter * (Math.random() * 2 - 1)) * every - performance.now());
      if (stopping) break;
      await actions[i]();
    }
  }));
  clearInterval(ticker);
  const el = (performance.now() - t0) / 1000;
  phaseStats[name] = { seconds: Number(el.toFixed(1)), requests: sent.requests - before, scans_per_s: Number(((sent.requests - before) / el).toFixed(2)) };
  console.log(`  ${name} done in ${el.toFixed(0)} s, ${phaseStats[name].scans_per_s} requests/s.`);
}

if (STEADY && !stopping) {
  console.log(`\nSteady phase: ${fmt(PL.steady.admit)} admissions over ${P.minutes} min...`);
  const seconds = P.minutes * 60;
  const spacing = (sc, k, n) => { const every = (seconds * 1000) / Math.max(1, n); return { first: Math.random() * every, every }; };
  await runPhase("steady", (sc, k, n) => {
    const acts = sc.queue.map((t) => () => admitNew(sc, t, "steady"));
    const reps = share(PL.steady.used, k, n);
    const dens = share(PL.steady.denied, k, n);
    // Repeats and denials go in the second half of the list mostly (a guest comes back later).
    for (let i = 0; i < reps; i++) acts.splice(Math.floor(acts.length * (0.3 + 0.7 * Math.random())), 0, () => repeatScan(sc, "steady"));
    for (let i = 0; i < dens; i++) acts.splice(Math.floor(acts.length * Math.random()), 0, () => deniedScan(sc, "steady"));
    return acts;
  }, spacing, 0.4);
}

if (BURST && !stopping) {
  console.log(`\nBurst: ${P.burstRate} scans/s for ${P.burstSeconds} s...`);
  const nScanners = P.parties * P.scanners;
  const every = (nScanners / P.burstRate) * 1000;
  await runPhase("burst", (sc, k, all) => {
    const n = { new: Math.min(sc.burstQueue.length, share(PL.burst.admit, k, all)), repeat: share(PL.burst.used, k, all),
      retry: share(PL.burst.retry, k, all), denied: share(PL.burst.denied, k, all) };
    const acts = shuffle([
      ...sc.burstQueue.slice(0, n.new).map((t) => () => admitNew(sc, t, "burst")),
      ...Array.from({ length: n.repeat }, () => () => repeatScan(sc, "burst")),
      ...Array.from({ length: n.retry }, () => () => sameIdRetry(sc, "burst")),
      ...Array.from({ length: n.denied }, () => () => deniedScan(sc, "burst")),
    ]);
    return acts;
  }, (sc, k) => ({ first: (k * 1000) / P.burstRate, every }), 0);
}

// ------------------------------------------------------------- correctness

// Is the Worker answering at all? If not, no check or cleanup can run now.
const probe = await call("GET", "/api/admission", undefined, parties[0].H, "admission", "admission_get", 3);
if (probe.status === 0 || probe.status >= 500) {
  console.log(`\nThe Worker is not answering (HTTP ${probe.status}): no ledger check and no cleanup were possible.`);
  console.log("The test sessions expire by themselves (owners 3 h, door phones 16 h). Admission stays open on these test");
  console.log(`parties (test tickets only); a site owner can switch them off on the platform page: ${parties.map((p) => p.id).join(", ")}`);
  console.log("Results so far:");
  console.log(JSON.stringify({ tally, errors: { ...errors, examples: errors.examples.slice(0, 5) }, violations, stopped_early: stopReason }, null, 2));
  process.exit(1);
}

// Scans whose answer never arrived: the same scan id once more gives the stored outcome.
for (const u of unresolved) {
  const v = await scan(u.sc, u.t.qr, u.id, "retry_same_id", "scan_retry");
  if (v.verdict === "admit") {
    u.t.admits.add(u.id);
    if (u.t.admits.size === 1) { u.t.party.admitted.push(u.t); count("resolved:admitted"); }
  } else if (v.verdict === "used" || v.verdict === null) {
    // Not stored under this id (the request never arrived), or still no answer: not admitted by us.
  }
  u.t.unresolved = v.verdict === null;
}

console.log("\nLedger check per party (main database admissions vs ledger records):");
const checks = [];
let fails = 0;
for (const p of parties) {
  const lc = await call("GET", "/api/test/ledger-check", undefined, p.H, "ledger-check", null, 3);
  const b = lc.body ?? {};
  const ours = p.admitted.length;
  const ok = lc.status === 200 && b.ok === true && b.nothing_reopened === true && b.missing === 0 && b.admissions === ours && b.tickets_used === ours;
  if (!ok) fails++;
  checks.push({ party: p.id, http: lc.status, our_admits: ours, admissions: b.admissions, ledger_records: b.ledger_records, tickets_used: b.tickets_used, missing: b.missing, orphan: b.orphan, reopened: b.reopened, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${p.id}: our admits ${ours}, admissions ${b.admissions}, ledger records ${b.ledger_records}, tickets used ${b.tickets_used}, missing ${b.missing}, orphan ${b.orphan}, reopened ${b.reopened}`);
}
const allTickets = parties.flatMap((p) => [...p.tickets, ...p.burst]);
const twice = allTickets.filter((t) => t.admits.size > 1).length;
const stillUnknown = allTickets.filter((t) => t.unresolved).length;

// ------------------------------------------------------------------ cleanup

console.log("\nCleanup: door access revoked, admission paused, test owner sessions ended...");
const cleanup = [];
for (const p of parties) {
  let rv;
  for (let i = 0; i < 20; i++) {
    rv = await call("POST", "/api/test/revoke-door-access", {}, p.H, "cleanup", null, 3);
    if (rv.status !== 503) break;
  }
  const pa = await call("POST", "/api/admission", { action: "pause" }, p.H, "cleanup", "pause", 3);
  const lo = await call("POST", "/api/auth/logout", {}, p.H, "cleanup", "logout", 3);
  cleanup.push({ party: p.id, revoke: rv.status, pause: pa.status, logout: lo.status });
  if (rv.status !== 200 || pa.status !== 200 || lo.status >= 400) console.log(`  party ${p.id}: revoke HTTP ${rv.status}, pause HTTP ${pa.status}, logout HTTP ${lo.status} (finish by hand)`);
}
await call("POST", "/api/auth/logout", {}, H0, "cleanup", "logout", 3);
console.log(`  ${cleanup.filter((c) => c.revoke === 200 && c.pause === 200 && c.logout < 400).length}/${parties.length} parties cleaned up.`);

if (reqLog) {
  if (reqLog.child) { console.log("\nWaiting 20 s for the last request events..."); await sleep(20000); }
  else await sleep(1500);
  reqLog.stop();
}

// ------------------------------------------------------------------- report

const scans = scanCount;
const errTotal = errors.http + errors.network + errors.unexpected;
console.log(`\n================ Report${LOCAL ? " (LOCAL rehearsal: wrangler dev on this machine, not Cloudflare)" : " (staging)"} ================`);
if (stopReason) console.log(`Stopped early: ${stopReason}.`);
console.log(`Admissions: steady ${tally["steady:admitted"] ?? 0}/${PL.steady.admit}, burst ${tally["burst:admitted"] ?? 0}/${PL.burst.admit}${tally["resolved:admitted"] ? `, resolved after a lost answer ${tally["resolved:admitted"]}` : ""}.`);
console.log(`Scans: ${scans} (repeat ${(tally["steady:repeat"] ?? 0) + (tally["burst:repeat"] ?? 0)}, denied ${(tally["steady:denied"] ?? 0) + (tally["burst:denied"] ?? 0)}, same-ID retries ${tally["burst:retry"] ?? 0}). Phases: ${JSON.stringify(phaseStats)}`);
console.log(`Errors: ${errTotal} of ${scans} scans (${scans ? ((100 * errTotal) / scans).toFixed(2) : "0"}%): HTTP ${errors.http}, network ${errors.network} (after 1 retry; ${networkRetries} retried), unexpected verdict ${errors.unexpected}; transient answers retried with the same scan id: recording ${errors.recording}, can't verify ${errors.cant_verify}.`);
for (const e of errors.examples.slice(0, 10)) console.log(`  e.g. ${JSON.stringify(e)}`);
const pass = violations.length === 0 && twice === 0 && fails === 0;
console.log(`${violations.length === 0 && twice === 0 ? "PASS" : "FAIL"}  every ticket admitted at most once by verdict (second admits: ${twice}; violations: ${violations.length})`);
for (const v of violations.slice(0, 10)) console.log(`  ${JSON.stringify(v)}`);
console.log(`${fails === 0 ? "PASS" : "FAIL"}  ledger check: admissions == ledger records == our admits, nothing missing, nothing reopened (${parties.length - fails}/${parties.length} parties)`);
if (stillUnknown) console.log(`  ${stillUnknown} ticket(s) still without a known outcome (no answer, even to the same-ID retry)`);

console.log("\nClient round trip (includes this machine's network; p50/p95/p99 only from n >= 100):");
const latOut = {};
for (const [k, xs] of Object.entries(lat).sort()) {
  const r = (p) => pct(xs, p).toFixed(0);
  latOut[k] = { n: xs.length, p50: Number(r(0.5)), p95: Number(r(0.95)), p99: Number(r(0.99)), max: Math.round(Math.max(...xs)) };
  console.log(`  ${k.padEnd(22)} n=${String(xs.length).padStart(5)}  ` + (xs.length >= 100
    ? `p50=${r(0.5)} ms  p95=${r(0.95)} ms  p99=${r(0.99)} ms  max=${latOut[k].max} ms`
    : `p50=${r(0.5)} ms  slowest seen ${latOut[k].max} ms (n < 100)`));
}

const est = spentEstimate();
let rows = { source: "estimated from the per-request costs measured locally (no request log collected)", requests_sent: sent.requests, rows_written: Math.round(est.written), rows_read: Math.round(est.read) };
let endpoints = [];
if (reqLog) {
  const m = rowTotals(reqLog.requests);
  endpoints = perEndpoint(reqLog.requests);
  const complete = m.requests >= sent.requests;
  rows = { source: `${reqLog.source}: ${m.requests} request log lines for ${sent.requests} requests sent${complete ? "" : " (some events missing: the totals are a lower bound; the estimate is shown too)"}`,
    requests_sent: sent.requests, main_rows_read: m.rows_read, main_rows_written: m.rows_written, ledger_rows_read: m.ledger_rows_read, ledger_rows_written: m.ledger_rows_written,
    estimate_rows_written: Math.round(est.written), estimate_rows_read: Math.round(est.read), tail_exceeded_cpu: reqLog.exceededCpu, unreadable: reqLog.unreadable };
  console.log(`\nPer endpoint (${reqLog.source}); kind: cold = isolate's first request, first = endpoint's first in a warm isolate, warm = the rest`);
  console.log("endpoint                          kind      n   cpu p50  p95  p99  max   rows/req main r/w   ledger r/w   statuses");
  const f = (v) => (v === null ? "  -" : String(v).padStart(4));
  for (const e of endpoints) {
    console.log(`${e.route.padEnd(33)} ${e.kind.padEnd(6)} ${String(e.n).padStart(5)}  ${f(e.cpu_p50)} ${f(e.cpu_p95)} ${f(e.cpu_p99)} ${f(e.cpu_max)}   ${String(e.rows_read_avg).padStart(6)}/${String(e.rows_written_avg).padEnd(5)} ${String(e.ledger_rows_read_avg).padStart(5)}/${String(e.ledger_rows_written_avg).padEnd(5)} ${JSON.stringify(e.statuses)}${e.kind === "warm" && e.cpu_n > 0 && e.cpu_n < 100 ? " (n < 100: slowest seen)" : ""}`);
  }
  if (!endpoints.some((e) => e.cpu_n > 0)) console.log("  (no CPU time in this source" + (LOCAL ? ": local runs have none)" : ")"));
}
console.log(`\nRows: ${rows.source}`);
if (reqLog) console.log(`  main read ${fmt(rows.main_rows_read)}, main written ${fmt(rows.main_rows_written)}, ledger read ${fmt(rows.ledger_rows_read)}, ledger written ${fmt(rows.ledger_rows_written)}; estimate was written ${fmt(rows.estimate_rows_written)}, read ${fmt(rows.estimate_rows_read)}`);
else console.log(`  written about ${fmt(rows.rows_written)}, read about ${fmt(rows.rows_read)}`);
console.log(`  Worker requests sent: ${fmt(sent.requests)} (pre-run estimate ${fmt(EST.total.requests)}).`);

const file = `load-test-report-${started.toISOString().replace(/[:.]/g, "-")}${LOCAL ? "-local" : ""}.json`;
writeFileSync(file, JSON.stringify({
  local: LOCAL, base: LOCAL ? base : link.hostname, started: started.toISOString(), finished: new Date().toISOString(), params: P, burst_mix: MIX,
  estimate: EST, stopped_early: stopReason, tally, phases: phaseStats, errors, network_retries: networkRetries, violations, second_admits: twice,
  unknown_outcome: stillUnknown, ledger_checks: checks, cleanup, latency_ms: latOut, rows, endpoints,
}, null, 2));
console.log(`\nSaved ${file} (no cookies, links or tokens).`);
console.log(`\n${pass ? "Load test passed." : "Load test FAILED (see above)."}`);
process.exit(pass ? 0 : 1);
