#!/usr/bin/env node
// Live CPU measurement on STAGING (setup.bat step 12).
//
// Method: `wrangler tail --env staging --format json` streams one event per
// request handled by sahra-staging, with Cloudflare's CPU and wall time for that
// request and the request's own log line. Our log line carries `iso_req` (the
// request's position in its isolate: 1 = cold, the isolate's first request) so
// cold and warm requests are reported separately, per endpoint.
//
// While this runs you sign in on staging, then the Checkpoint A traffic runs. At
// the end it prints, per endpoint and cold/warm: count, p50, p95, p99, max CPU ms,
// plus any requests that exceeded CPU. It writes a summary (no cookies, no links,
// no secrets) to cpu-report-<time>.json.
//
// Limits: tail may sample when traffic is heavy (the report shows how many events
// it saw); percentiles over few samples are rough and are labelled with their count.

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const WIN = process.platform === "win32";
// --auto: no prompts (cloud sessions); --invite <link> supplies the traffic link.
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
  return acc;
}, []));

async function ask(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

const events = [];
let parseErrors = 0;

function startTail() {
  const full = ["wrangler", "tail", "--env", "staging", "--format", "json"];
  const child = WIN
    ? spawn(["npx.cmd", ...full].join(" "), { shell: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("npx", full, { stdio: ["ignore", "pipe", "pipe"] });
  // wrangler prints each event as indented JSON: an object starts with "{" and
  // ends with "}" alone at the start of a line.
  let buf = [];
  let carry = "";
  child.stdout.on("data", (d) => {
    const lines = (carry + d).split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (buf.length === 0 && line !== "{") continue;
      buf.push(line);
      if (line === "}") {
        try { events.push(JSON.parse(buf.join("\n"))); } catch { parseErrors++; }
        buf = [];
      }
    }
  });
  let errText = "";
  child.stderr.on("data", (d) => { errText += d; });
  child.errText = () => errText;
  return child;
}

function stopTail(child) {
  if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGINT");
}

function pathOf(ev) {
  try {
    const u = new URL(ev.event?.request?.url ?? "");
    return u.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id");
  } catch {
    return "(non-request)";
  }
}

function ourLog(ev) {
  for (const l of ev.logs ?? []) {
    const m = Array.isArray(l.message) ? l.message[0] : l.message;
    if (typeof m === "string" && m.startsWith('{"evt":"req"')) {
      try { return JSON.parse(m); } catch { /* ignore */ }
    }
  }
  return null;
}

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

function avg(xs) {
  return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "-";
}

function report() {
  const rows = new Map();
  const perRequest = [];
  let withCpu = 0;
  let exceeded = 0;
  for (const ev of events) {
    const cpu = typeof ev.cpuTime === "number" ? ev.cpuTime : null;
    if (cpu !== null) withCpu++;
    if (ev.outcome === "exceededCpu") exceeded++;
    const log = ourLog(ev);
    // cold = the isolate's first request; first = this endpoint's first request in
    // an already-warm isolate (first use of that code path); warm = everything else.
    const kind = !log ? "unknown" : log.iso_req === 1 ? "cold" : log.route_req === 1 ? "first" : "warm";
    const jw = log && log.jwks && log.jwks !== "none" ? ` [keys ${log.jwks}]` : "";
    const key = `${ev.event?.request?.method ?? "?"} ${pathOf(ev)}${jw}|${kind}`;
    if (!rows.has(key)) rows.set(key, { cpu: [], wall: [], outcomes: {}, written: [], ledgerWritten: [] });
    const r = rows.get(key);
    if (log && typeof log.rows_written === "number") r.written.push(log.rows_written);
    if (log && typeof log.ledger_rows_written === "number") r.ledgerWritten.push(log.ledger_rows_written);
    if (cpu !== null) r.cpu.push(cpu);
    if (cpu !== null) {
      perRequest.push({ path: key.split("|")[0], kind, cpu, wall: ev.wallTime ?? null, status: log?.status ?? null,
        iso_req: log?.iso_req ?? null, route_req: log?.route_req ?? null, in_flight: log?.in_flight ?? null, iso_age_ms: log?.iso_age_ms ?? null });
    }
    if (typeof ev.wallTime === "number") r.wall.push(ev.wallTime);
    r.outcomes[ev.outcome ?? "?"] = (r.outcomes[ev.outcome ?? "?"] ?? 0) + 1;
  }
  console.log(`\nEvents captured: ${events.length} (with CPU time: ${withCpu}; unreadable: ${parseErrors}; exceeded CPU: ${exceeded})`);
  if (events.length > 0 && withCpu === 0) {
    console.log("\nThis tail stream did not include CPU time. Use Workers Logs instead (Invocations view,");
    console.log("search by path; the expanded log line shows iso_req, where 1 = cold).");
  }
  const out = [];
  console.log("\nkind: cold = isolate's first request; first = endpoint's first request in a warm isolate; warm = the rest");
  console.log("CPU ms per request (staging)                  kind   n     p50   p95   p99   max   rows/req main+ledger  outcomes");
  for (const [key, r] of [...rows].sort()) {
    const [path, kind] = key.split("|");
    const n = r.cpu.length;
    const fmt = (v) => (v === undefined ? "  -  " : String(v).padStart(5));
    const line = `${path.padEnd(45)} ${kind.padEnd(6)} ${String(n).padStart(4)} ${fmt(n ? pct(r.cpu, 0.5) : undefined)} ${fmt(n ? pct(r.cpu, 0.95) : undefined)} ${fmt(n ? pct(r.cpu, 0.99) : undefined)} ${fmt(n ? Math.max(...r.cpu) : undefined)}   ${avg(r.written).padStart(5)} + ${avg(r.ledgerWritten).padEnd(5)}        ${JSON.stringify(r.outcomes)}${kind === "warm" && n < 100 ? "   (n < 100: slowest seen, not a p99)" : ""}`;
    console.log(line);
    out.push({ path, kind, n, rows_written_avg: Number(avg(r.written)), ledger_rows_written_avg: Number(avg(r.ledgerWritten)), p50: n ? pct(r.cpu, 0.5) : null, p95: n ? pct(r.cpu, 0.95) : null, p99: n ? pct(r.cpu, 0.99) : null, max: n ? Math.max(...r.cpu) : null, wall_p95: r.wall.length ? pct(r.wall, 0.95) : null, outcomes: r.outcomes });
  }
  // The slowest warm requests, with what was going on in their isolate.
  const slow = perRequest.filter((x) => x.kind === "warm").sort((a, b) => b.cpu - a.cpu).slice(0, 15);
  if (slow.length) {
    console.log("\nSlowest warm requests: cpu ms, endpoint, isolate request #, endpoint request #, requests running at once, status");
    for (const x of slow) console.log(`  ${String(x.cpu).padStart(3)}  ${x.path.padEnd(32)} iso#${x.iso_req}  route#${x.route_req}  in_flight=${x.in_flight ?? "?"}  ${x.status}`);
  }
  const file = `cpu-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ captured: events.length, with_cpu: withCpu, exceeded_cpu: exceeded, rows: out, requests: perRequest }, null, 2));
  console.log(`\nSaved summary to ${file} (no cookies, links or secrets).`);
  console.log("Target: warm p99 under 5 ms on every endpoint. Cold and first-use rows are reported separately;");
  console.log("rows with few requests (n) are indicative only.");
}

const tail = startTail();
console.log("Connecting to the staging request stream (wrangler tail)...");
await new Promise((ok) => setTimeout(ok, 8000));
if (tail.exitCode !== null) {
  console.error("wrangler tail stopped:\n" + tail.errText());
  process.exit(1);
}
if (args.auto !== "true") {
  await ask(`\n1) Now, on STAGING in a private window: sign in and out ${args.signins ?? "5"} times, and create
   ${args.invites ?? "3"} door invitations on the dashboard (revoke them afterwards).
   Press Enter here when done. `);
}
const link = args.invite ?? (await ask("\n2) For scan traffic too: create a NEW door invitation (1 hour) and paste its link here.\n   Or just press Enter to measure only what you did in step 1: "));
if (link) {
  await new Promise((ok) => spawn(process.execPath, ["scripts/live-check.mjs", "--invite", link], { stdio: "inherit" }).on("close", ok));
}
console.log("\nWaiting 20 s for the last events...");
await new Promise((ok) => setTimeout(ok, 20000));
stopTail(tail);
report();
process.exit(0);
