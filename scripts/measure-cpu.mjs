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
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
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

function report() {
  const rows = new Map();
  let withCpu = 0;
  let exceeded = 0;
  for (const ev of events) {
    const cpu = typeof ev.cpuTime === "number" ? ev.cpuTime : null;
    if (cpu !== null) withCpu++;
    if (ev.outcome === "exceededCpu") exceeded++;
    const log = ourLog(ev);
    const kind = log ? (log.iso_req === 1 ? "cold" : "warm") : "unknown";
    const key = `${ev.event?.request?.method ?? "?"} ${pathOf(ev)}|${kind}`;
    if (!rows.has(key)) rows.set(key, { cpu: [], wall: [], outcomes: {} });
    const r = rows.get(key);
    if (cpu !== null) r.cpu.push(cpu);
    if (typeof ev.wallTime === "number") r.wall.push(ev.wallTime);
    r.outcomes[ev.outcome ?? "?"] = (r.outcomes[ev.outcome ?? "?"] ?? 0) + 1;
  }
  console.log(`\nEvents captured: ${events.length} (with CPU time: ${withCpu}; unreadable: ${parseErrors}; exceeded CPU: ${exceeded})`);
  if (events.length > 0 && withCpu === 0) {
    console.log("\nThis tail stream did not include CPU time. Use Workers Logs instead (Invocations view,");
    console.log("search by path; the expanded log line shows iso_req, where 1 = cold).");
  }
  const out = [];
  console.log("\nCPU ms per request (staging)      kind   n     p50   p95   p99   max   outcomes");
  for (const [key, r] of [...rows].sort()) {
    const [path, kind] = key.split("|");
    const n = r.cpu.length;
    const fmt = (v) => (v === undefined ? "  -  " : String(v).padStart(5));
    const line = `${path.padEnd(34)} ${kind.padEnd(6)} ${String(n).padStart(4)} ${fmt(n ? pct(r.cpu, 0.5) : undefined)} ${fmt(n ? pct(r.cpu, 0.95) : undefined)} ${fmt(n ? pct(r.cpu, 0.99) : undefined)} ${fmt(n ? Math.max(...r.cpu) : undefined)}   ${JSON.stringify(r.outcomes)}`;
    console.log(line);
    out.push({ path, kind, n, p50: n ? pct(r.cpu, 0.5) : null, p95: n ? pct(r.cpu, 0.95) : null, p99: n ? pct(r.cpu, 0.99) : null, max: n ? Math.max(...r.cpu) : null, wall_p95: r.wall.length ? pct(r.wall, 0.95) : null, outcomes: r.outcomes });
  }
  const file = `cpu-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ captured: events.length, with_cpu: withCpu, exceeded_cpu: exceeded, rows: out }, null, 2));
  console.log(`\nSaved summary to ${file} (no cookies, links or secrets).`);
  console.log("Target: warm p99 under 5 ms on every endpoint. Cold rows are reported separately.");
}

const tail = startTail();
console.log("Connecting to the staging request stream (wrangler tail)...");
await new Promise((ok) => setTimeout(ok, 8000));
if (tail.exitCode !== null) {
  console.error("wrangler tail stopped:\n" + tail.errText());
  process.exit(1);
}
await ask("\n1) Now, in a private window, sign in on STAGING, sign out, and sign in again (3 times).\n   Press Enter here when done. ");
const link = args.invite ?? (await ask("\n2) Create a NEW door invitation on the staging dashboard (1 hour) and paste its link here: "));
const phones = args.phones ?? "8";
await new Promise((ok) => spawn(process.execPath, ["scripts/checkpoint-a.mjs", "--invite", link, "--scans", args.scans ?? "50", "--phones", phones], { stdio: "inherit" }).on("close", ok));
console.log("\nWaiting 20 s for the last events...");
await new Promise((ok) => setTimeout(ok, 20000));
stopTail(tail);
report();
process.exit(0);
