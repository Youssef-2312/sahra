#!/usr/bin/env node
// Local CPU profile of the Worker code (a development tool; nothing here talks to
// Cloudflare). The app runs in Node's V8 against two real SQLite databases with
// the migrations applied; time spent inside SQLite is subtracted, because on
// Cloudflare the database runs elsewhere. This shows how much JavaScript work a
// request does, cold (a fresh isolate's first request) versus warm. It does not
// include the cost of Cloudflare's own binding code, so live numbers are higher.
//
//   node scripts/cpu-local.mjs              all scenarios
//   node scripts/cpu-local.mjs scan         only "scan first" (cold scan)
//   node scripts/cpu-local.mjs --prof scan  also write a .cpuprofile (open in Chrome DevTools)
//   node scripts/cpu-local.mjs --no-warmup  without the startup warm-up (src/warmup.ts)

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://sahra.test";

// ---------------------------------------------------------------- D1 stand-in

async function d1(file, migrationsDir) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  if (migrationsDir) for (const f of readdirSync(join(ROOT, migrationsDir)).sort()) db.exec(readFileSync(join(ROOT, migrationsDir, f), "utf8"));
  const spent = { ms: 0 };
  const run = (text, params) => {
    const st = db.prepare(text);
    const results = st.all(...params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p)));
    const changes = Number(db.prepare("SELECT changes() AS n").get().n);
    return { results, success: true, meta: { changes, rows_read: results.length, rows_written: /^\s*(INSERT|UPDATE|DELETE)/i.test(text) ? changes : 0 } };
  };
  const timed = (fn) => { const t = performance.now(); try { return fn(); } finally { spent.ms += performance.now() - t; } };
  const stmt = (text, params) => {
    const exec = async () => timed(() => run(text, params));
    return { text, params, bind: (...p) => stmt(text, p), all: exec, run: exec };
  };
  const prepare = (text) => stmt(text, []);
  return {
    spent,
    raw: db,
    binding: {
      prepare,
      batch: async (stmts) => timed(() => {
        db.exec("BEGIN");
        try {
          const out = stmts.map((s) => run(s.text, s.params));
          db.exec("COMMIT");
          return out;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }),
    },
  };
}

// ------------------------------------------------------------------ the app

function bundle(dir) {
  // One module, as on Cloudflare: the warm-up must compile the same functions the requests run.
  const entry = join(dir, "entry.ts");
  const src = (f) => JSON.stringify(join(ROOT, "src", f));
  writeFileSync(entry, [
    `export { createApp, resetRequestCounters } from ${src("app.ts")};`,
    `export { warmUp } from ${src("warmup.ts")};`,
    `export { JwksCache } from ${src("auth/google.ts")};`,
    `export * from ${src("lib/crypto.ts")};`,
  ].join("\n"));
  execFileSync(join(ROOT, "node_modules/.bin/esbuild"), [entry, "--bundle", "--format=esm", "--platform=node", `--outfile=${join(dir, "app.mjs")}`, "--log-level=error"]);
  return dir;
}

async function load(dir, files) {
  const main = await d1(join(dir, "main.db"), files ? null : "migrations");
  const ledger = await d1(join(dir, "ledger.db"), files ? null : "migrations-ledger");
  const mod = await import(join(dir, "app.mjs"));
  const { createApp, JwksCache } = mod;
  const fetcher = () => { throw new Error("no network in the local profile"); };
  const app = createApp({ fetch: fetcher, now: () => Date.now(), jwks: new JwksCache(fetcher) });
  const secrets = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"));
  const limiter = { limit: async () => ({ success: true }) };
  const env = {
    DB: main.binding, LEDGER: ledger.binding, RL_AUTH: limiter, RL_SCAN: limiter, PUBLIC_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: "local.apps.googleusercontent.com", ENABLE_TEST_TICKETS: "1", QR_KEY_ID: "1", COOKIE_KEY_ID: "1", ...secrets,
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const quiet = console.log;
  // One request: wall time minus time inside SQLite (no real I/O here, so wall ~ CPU).
  const call = async (path, { method = "POST", body, token, csrf } = {}) => {
    const headers = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.cookie = `__Host-sahra_s=${token}`;
    if (csrf) headers["x-sahra-csrf"] = csrf;
    const req = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sql0 = main.spent.ms + ledger.spent.ms;
    console.log = () => {};
    const t = performance.now();
    let res;
    try {
      res = await app.fetch(req, env, ctx);
    } finally {
      console.log = quiet;
    }
    const ms = performance.now() - t - (main.spent.ms + ledger.spent.ms - sql0);
    return { ms, status: res.status, json: await res.json() };
  };
  // The startup warm-up, under the global-scope rules Workers enforce (no random values).
  const warm = async () => {
    const uuid = crypto.randomUUID, rv = crypto.getRandomValues;
    const disallowed = () => { throw new Error("Disallowed operation called within global scope"); };
    crypto.randomUUID = disallowed;
    crypto.getRandomValues = disallowed;
    try {
      await mod.warmUp(app, mod.resetRequestCounters);
    } finally {
      crypto.randomUUID = uuid;
      crypto.getRandomValues = rv;
    }
  };
  return { call, main, ledger, warm };
}

// ------------------------------------------------------------------- setup

async function setup(dir) {
  const { csrfFor, newToken, parseToken, sha256hex, b64url } = await import(join(dir, "app.mjs"));
  const rnd = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ QR_MASTER_K1: rnd(), LINK_MASTER_K1: rnd(), COOKIE_MASTER_K1: rnd() }));
  const { call, main } = await load(dir, false);
  const now = Date.now();
  main.raw.exec(`INSERT INTO parties (id, name, capacity, created_at, logged_rev) VALUES ('local', 'Local', 300, ${now}, 1)`);
  main.raw.exec(`INSERT INTO staff (id, party_id, name, role, google_sub, invited_email, created_at, logged_rev) VALUES ('owner-1', 'local', 'Owner', 'owner', 'sub-1', 'o@gmail.com', ${now}, 1)`);
  const token = newToken();
  main.raw.exec(`INSERT INTO sessions (id_hash, kind, party_id, staff_id, role, created_at, expires_at) VALUES ('${await sha256hex(token)}', 'google', 'local', 'owner-1', 'owner', ${now}, ${now + 86400_000})`);
  const owner = { token, csrf: await csrfFor(parseToken(token)) };
  const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  must(await call("/api/admission", { ...owner, body: { action: "open" } }), "open");
  // Door session for scanning (joined through the API), invitations for later joins, tickets.
  const invites = [];
  for (let i = 0; i < 260; i++) invites.push(must(await call("/api/test/door-invite", { ...owner, body: {} }), "invite").token);
  const doorToken = newToken();
  must(await call("/api/invites/consume", { body: { token: invites.pop(), session: doorToken } }), "join");
  const door = { token: doorToken, csrf: await csrfFor(parseToken(doorToken)) };
  const tickets = [];
  for (let i = 0; i < 20; i++) tickets.push(...must(await call("/api/test/tickets", { ...door, body: { count: 20 } }), "tickets").tickets);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ owner, door, invites, tickets }));
}

// --------------------------------------------------------------- scenarios

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x) => x.toFixed(2).padStart(6);

// Node implements Request, Response, Headers, streams and WebCrypto partly in
// lazily loaded JavaScript; workerd implements them natively. Use each once with
// unrelated data first, so the cold numbers count the app's own code.
async function warmPlatform() {
  const r = new Request("https://x.test/a", { method: "POST", headers: { "content-type": "application/json", cookie: "a=b" }, body: "{\"a\":1}" });
  await r.json();
  const res = new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  res.headers.set("x-a", "1");
  res.headers.append("set-cookie", "a=b");
  await res.json();
  const raw = crypto.getRandomValues(new Uint8Array(32));
  await crypto.subtle.digest("SHA-256", raw);
  const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits", "deriveKey"]);
  const p = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(1), info: new Uint8Array(1) };
  const bits = await crypto.subtle.deriveBits(p, ikm, 256);
  const hk = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  await crypto.subtle.sign("HMAC", hk, raw);
  const ak = await crypto.subtle.deriveKey(p, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, ak, raw);
  new TextEncoder().encode("a"); new TextDecoder().decode(raw); btoa("a"); atob("YQ"); crypto.randomUUID();
}

async function scenario(dir, first, withWarmUp) {
  await warmPlatform();
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const { call, warm } = await load(dir, true);
  if (withWarmUp) await warm();
  const { newToken } = await import(join(dir, "app.mjs"));
  const uuid = () => crypto.randomUUID();
  let ti = 0, ii = 0;
  const kinds = {
    scan: () => call("/api/scan", { ...st.door, body: { scan_id: uuid(), qr: st.tickets[ti++].qr } }),
    consume: () => call("/api/invites/consume", { body: { token: st.invites[ii++], session: newToken() } }),
    me: () => call("/api/me", { ...st.door, method: "GET" }),
    admission: () => call("/api/admission", { ...st.door, method: "GET" }),
  };
  if (first.includes(",")) {
    // Only these requests, in order (for a profile of exactly that work).
    const out = {};
    for (const k of first.split(",")) out[k] = { cold: (await kinds[k]()).ms, firstUse: 0, warm: [0] };
    return out;
  }
  const results = { [first]: { cold: (await kinds[first]()).ms } };
  for (const k of Object.keys(kinds)) {
    const r = (results[k] ??= {});
    r.firstUse ??= (await kinds[k]()).ms;
    r.warm = [];
    for (let i = 0; i < 120; i++) r.warm.push((await kinds[k]()).ms);
  }
  return results;
}

const argv = process.argv.slice(2);
if (argv[0] === "--child") {
  const r = await scenario(argv[1], argv[2], argv[3] === "warm");
  process.stdout.write(JSON.stringify(r));
} else {
  const prof = argv.includes("--prof");
  const noWarm = argv.includes("--no-warmup");
  const only = argv.filter((a) => !a.startsWith("--"));
  const firsts = only.length ? only : ["scan", "consume", "me"];
  console.log(`JavaScript time per request, SQLite time excluded (ms). Each row: a fresh process whose first request is <first>; startup warm-up ${noWarm ? "OFF" : "ON"}.`);
  console.log("first      endpoint   cold    firstUse  warm p50  p95    p99    max");
  for (const first of firsts) {
    const dir = bundle(mkdtempSync(join(tmpdir(), "sahra-cpu-")));
    await setup(dir);
    const args = [...(prof ? ["--cpu-prof", "--cpu-prof-interval=20", `--cpu-prof-dir=${dir}`] : []), "--no-warnings", fileURLToPath(import.meta.url), "--child", dir, first, noWarm ? "cold" : "warm"];
    const p = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (p.status !== 0) throw new Error(p.stderr);
    const r = JSON.parse(p.stdout);
    for (const [k, v] of Object.entries(r)) {
      console.log(`${first.padEnd(10)} ${k.padEnd(10)} ${v.cold === undefined ? "     -" : f(v.cold)}  ${f(v.firstUse)}    ${f(pct(v.warm, 0.5))} ${f(pct(v.warm, 0.95))} ${f(pct(v.warm, 0.99))} ${f(Math.max(...v.warm))}`);
    }
    if (prof) console.log(`  profile: ${dir}/*.cpuprofile`);
  }
}
