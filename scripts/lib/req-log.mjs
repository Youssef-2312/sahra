// The Worker's own request log line ({"evt":"req", ...}, src/app.ts) collected
// while a script runs, from either:
//  - `wrangler tail --env staging --format json` (live; also gives Cloudflare's CPU
//    time per request; needs CLOUDFLARE_API_TOKEN with Workers Tail Read), or
//  - the output file of a local `wrangler dev` (rehearsals; rows only, no CPU).
// Same parsing as scripts/measure-cpu.mjs. Nothing here prints cookies or links.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const WIN = process.platform === "win32";

/** One collected request: our log fields plus CPU/wall time when the tail has them. */
function fromLog(log, extra = {}) {
  return {
    route: `${log.method} ${log.route}`,
    status: log.status,
    rows_read: Number(log.rows_read ?? 0),
    rows_written: Number(log.rows_written ?? 0),
    ledger_rows_read: Number(log.ledger_rows_read ?? 0),
    ledger_rows_written: Number(log.ledger_rows_written ?? 0),
    // cold = the isolate's first request; first = this endpoint's first request in a warm isolate.
    kind: log.iso_req === 1 ? "cold" : log.route_req === 1 ? "first" : "warm",
    in_flight: log.in_flight ?? null,
    cpu: null,
    wall: null,
    ...extra,
  };
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

/** Starts collecting. `source`: { tail: true } or { file: "<wrangler dev output>" }. */
export function startRequestLog(source) {
  const st = { requests: [], events: 0, unreadable: 0, exceededCpu: 0, source: source.tail ? "wrangler tail" : `local log ${source.file}`, stop: () => {}, error: () => "" };
  if (source.tail) {
    const full = ["wrangler", "tail", "--env", "staging", "--format", "json"];
    const child = WIN
      ? spawn(["npx.cmd", ...full].join(" "), { shell: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("npx", full, { stdio: ["ignore", "pipe", "pipe"] });
    // wrangler prints each event as indented JSON: "{" ... "}" alone at the start of a line.
    let buf = [];
    let carry = "";
    child.stdout.on("data", (d) => {
      const lines = (carry + d).split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (buf.length === 0 && line !== "{") continue;
        buf.push(line);
        if (line === "}") {
          try {
            const ev = JSON.parse(buf.join("\n"));
            st.events++;
            if (ev.outcome === "exceededCpu") st.exceededCpu++;
            const log = ourLog(ev);
            if (log) st.requests.push(fromLog(log, { cpu: typeof ev.cpuTime === "number" ? ev.cpuTime : null, wall: ev.wallTime ?? null }));
          } catch { st.unreadable++; }
          buf = [];
        }
      }
    });
    let errText = "";
    child.stderr.on("data", (d) => { errText += d; });
    st.child = child;
    st.error = () => errText;
    st.stop = () => {
      if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGINT");
    };
    return st;
  }
  // Local: read what wrangler dev appended to its output file since we started.
  let offset = existsSync(source.file) ? statSync(source.file).size : 0;
  let carry = "";
  const poll = () => {
    if (!existsSync(source.file)) return;
    const size = statSync(source.file).size;
    if (size <= offset) return;
    const fd = openSync(source.file, "r");
    const b = Buffer.alloc(size - offset);
    readSync(fd, b, 0, b.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (carry + b.toString("utf8")).split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const i = line.indexOf('{"evt":"req"');
      if (i < 0) continue;
      try { st.events++; st.requests.push(fromLog(JSON.parse(line.slice(i)))); } catch { st.unreadable++; }
    }
  };
  const timer = setInterval(poll, 500);
  st.stop = () => { clearInterval(timer); poll(); };
  return st;
}

/** Sums of rows over the collected requests. */
export function rowTotals(requests) {
  const t = { requests: requests.length, rows_read: 0, rows_written: 0, ledger_rows_read: 0, ledger_rows_written: 0 };
  for (const r of requests) {
    t.rows_read += r.rows_read;
    t.rows_written += r.rows_written;
    t.ledger_rows_read += r.ledger_rows_read;
    t.ledger_rows_written += r.ledger_rows_written;
  }
  return t;
}

export function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

/** Per endpoint and cold/first/warm: CPU percentiles (when present) and average rows. */
export function perEndpoint(requests) {
  const rows = new Map();
  for (const r of requests) {
    const key = `${r.route}|${r.kind}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(r);
  }
  const avg = (xs) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null);
  return [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([key, rs]) => {
    const [route, kind] = key.split("|");
    const cpu = rs.map((r) => r.cpu).filter((x) => typeof x === "number");
    return {
      route, kind, n: rs.length, cpu_n: cpu.length,
      cpu_p50: cpu.length ? pct(cpu, 0.5) : null, cpu_p95: cpu.length ? pct(cpu, 0.95) : null,
      cpu_p99: cpu.length ? pct(cpu, 0.99) : null, cpu_max: cpu.length ? Math.max(...cpu) : null,
      rows_read_avg: avg(rs.map((r) => r.rows_read)), rows_written_avg: avg(rs.map((r) => r.rows_written)),
      ledger_rows_read_avg: avg(rs.map((r) => r.ledger_rows_read)), ledger_rows_written_avg: avg(rs.map((r) => r.ledger_rows_written)),
      statuses: rs.reduce((o, r) => ((o[r.status] = (o[r.status] ?? 0) + 1), o), {}),
    };
  });
}
