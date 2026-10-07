#!/usr/bin/env node
// Owner operations, run on the owner's computer (Windows, macOS or Linux), usually
// through setup.bat. Every step is safe to run again:
//   - migrations: wrangler skips migrations already applied;
//   - staging-only tables: CREATE TABLE IF NOT EXISTS;
//   - secrets: only missing ones are created (existing values are never replaced);
//   - create-party: refuses if the party id already exists.
// Temporary Cloudflare/network errors are retried (2, 4, 8, 16 s). Secret values are
// generated here and piped straight into wrangler; they are never printed.
//
//   node scripts/ops.mjs login
//   node scripts/ops.mjs migrate staging|prod
//   node scripts/ops.mjs status
//   node scripts/ops.mjs secrets staging|prod
//   node scripts/ops.mjs google-secret staging|prod
//   node scripts/ops.mjs create-party
//   node scripts/ops.mjs checkpoint
//   node scripts/ops.mjs verify-ledger          (read-only, staging)

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const WIN = process.platform === "win32";
// `--env=` selects the top-level (production) config explicitly; it also avoids
// wrangler's "multiple environments" warning and survives Windows argument quoting.
const ENVS = { staging: ["--env", "staging"], prod: ["--env="] };
const GENERATED_SECRETS = ["COOKIE_MASTER_K1", "QR_MASTER_K1", "LINK_MASTER_K1"];

// Errors that will not go away by retrying.
const PERMANENT = /does not exist|\[code: 10007\]|not logged in|not authenticated|CLOUDFLARE_API_TOKEN|wrangler login|Authentication error|\[code: 10000\]|Unknown argument|Couldn't find a D1 DB|no such table|SQLITE_|syntax error|UNIQUE constraint|already exists/i;

function quote(a) {
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** Runs `npx wrangler ...`; streams output; returns { code, out }. */
function wranglerOnce(args, { input, interactive = false, quiet = false } = {}) {
  return new Promise((resolve) => {
    const cmd = WIN ? "npx.cmd" : "npx";
    const full = ["wrangler", ...args];
    const child = spawn(WIN ? [cmd, ...full.map(quote)].join(" ") : cmd, WIN ? [] : full, {
      shell: WIN,
      stdio: interactive ? "inherit" : [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let stdoutOnly = "";
    if (!interactive) {
      child.stdout.on("data", (d) => { out += d; stdoutOnly += d; if (!quiet) stdout.write(d); });
      child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
      if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    }
    child.on("close", (code) => resolve({ code: code ?? 1, out, stdout: stdoutOnly }));
  });
}

async function wrangler(args, opts = {}) {
  const delays = [2, 4, 8, 16];
  for (let attempt = 0; ; attempt++) {
    const r = await wranglerOnce(args, opts);
    if (r.code === 0) return r;
    if (PERMANENT.test(r.out) || attempt >= delays.length) {
      throw new Error(`wrangler ${args.filter((a) => !a.startsWith("--command")).slice(0, 4).join(" ")} failed`);
    }
    console.log(`\nTemporary error? Retrying in ${delays[attempt]} s (attempt ${attempt + 2} of ${delays.length + 1})...`);
    await new Promise((ok) => setTimeout(ok, delays[attempt] * 1000));
  }
}

async function ask(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

function envArg(name) {
  if (!(name in ENVS)) throw new Error("say staging or prod");
  return ENVS[name];
}

async function confirmProd(name, what) {
  if (name !== "prod") return;
  const a = await ask(`This changes PRODUCTION (${what}). Type PROD to continue: `);
  if (a !== "PROD") throw new Error("cancelled");
}

const steps = {
  async login() {
    const r = await wranglerOnce(["whoami"]);
    if (r.code !== 0 || /not authenticated|not logged in/i.test(r.out)) {
      await wranglerOnce(["login"], { interactive: true });
    }
  },

  async migrate(name) {
    const e = envArg(name);
    await confirmProd(name, "database migrations");
    await wrangler(["d1", "migrations", "apply", "DB", "--remote", ...e]);
    await wrangler(["d1", "migrations", "apply", "LEDGER", "--remote", ...e]);
    if (name === "staging") {
      await wrangler(["d1", "execute", "DB", "--remote", ...e, "--file", "migrations-staging/main/0001_proto.sql"]);
      await wrangler(["d1", "execute", "LEDGER", "--remote", ...e, "--file", "migrations-staging/ledger/0001_proto.sql"]);
    }
    await steps.status(name);
  },

  async status(only) {
    let pending = false;
    for (const name of only ? [only] : ["staging", "prod"]) {
      for (const db of ["DB", "LEDGER"]) {
        console.log(`\n== ${name} ${db}`);
        const r = await wrangler(["d1", "migrations", "list", db, "--remote", ...ENVS[name]]);
        if (!/No migrations to apply/i.test(r.out)) pending = true;
      }
    }
    console.log(pending ? "\nSome migrations are NOT applied yet (see above)." : "\nAll checked databases: nothing to apply.");
  },

  async secrets(name) {
    const e = envArg(name);
    await confirmProd(name, "create missing secrets");
    const list = await wrangler(["secret", "list", ...e]);
    const have = new Set([...list.out.matchAll(/"name":\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]));
    for (const s of GENERATED_SECRETS) {
      if (have.has(s)) { console.log(`${s}: already set, left unchanged`); continue; }
      console.log(`${s}: creating a new random value for ${name}`);
      await wrangler(["secret", "put", s, ...e], { input: randomBytes(32).toString("base64url") });
    }
    if (!have.has("GOOGLE_CLIENT_SECRET")) console.log(`GOOGLE_CLIENT_SECRET: not set yet (use the Google client secret step for ${name})`);
  },

  async "google-secret"(name) {
    const e = envArg(name);
    await confirmProd(name, "Google client secret");
    console.log(`Paste the client secret of the ${name.toUpperCase()} Google OAuth client when asked (input is hidden).`);
    await wranglerOnce(["secret", "put", "GOOGLE_CLIENT_SECRET", ...e], { interactive: true });
  },

  async "create-party"() {
    const name = (await ask("Environment (staging/prod): ")).toLowerCase();
    envArg(name);
    const id = await ask("Party id (3-24 chars, lowercase letters, digits, dashes): ");
    const r = await wrangler(["d1", "execute", "DB", "--remote", ...ENVS[name], "--json", "--command", `SELECT COUNT(*) AS n FROM parties WHERE id = '${id.replace(/[^a-z0-9-]/g, "")}'`]);
    if (/"n":\s*[1-9]/.test(r.out)) { console.log(`Party ${id} already exists in ${name}; nothing done.`); return; }
    const args = ["scripts/create-party.mjs", "--env", name, "--id", id,
      "--name", await ask("Party name: "), "--capacity", await ask("Capacity (people): "),
      "--max-per-ticket", await ask("Max people per ticket: "), "--owner-name", await ask("Owner name: "),
      "--owner-email", await ask("Owner Gmail address: ")];
    await confirmProd(name, `create party ${id}`);
    await new Promise((ok, fail) => spawn(process.execPath, args, { stdio: "inherit" }).on("close", (c) => (c === 0 ? ok() : fail(new Error("create-party failed")))));
  },

  // Read-only: compares admitted prototype tickets (sahra-staging) with admission
  // records (sahra-ledger-staging), by ticket id AND rev. Every ticket admitted in
  // the main database must have its ledger record (green-screen rule).
  async "verify-ledger"() {
    const party = ((await ask("Party id [checkpoint-a]: ")) || "checkpoint-a").replace(/[^a-z0-9-]/g, "");
    const query = async (db, sql) => {
      const r = await wrangler(["d1", "execute", db, "--remote", "--env", "staging", "--json", "--command", sql], { quiet: true });
      // The JSON result starts on its own line ("[" alone); anything before it is wrangler chatter.
      const start = r.stdout.search(/^\[\s*$/m);
      if (start < 0) throw new Error("could not read the query result");
      const json = JSON.parse(r.stdout.slice(start));
      return json[0].results;
    };
    const admitted = await query("DB", `SELECT id, rev, used_scan_id FROM proto_tickets WHERE party_id = '${party}' AND used_scan_id IS NOT NULL`);
    const scans = await query("DB", `SELECT outcome, COUNT(*) AS n FROM proto_scans WHERE party_id = '${party}' GROUP BY outcome`);
    const tickets = await query("DB", `SELECT COUNT(*) AS n FROM proto_tickets WHERE party_id = '${party}'`);
    const records = await query("LEDGER", `SELECT key FROM proto_admissions WHERE key LIKE '${party}/%'`);
    const recordKeys = new Set(records.map((r) => r.key));
    const admittedKeys = new Set(admitted.map((t) => `${party}/${t.id}/${t.rev}`));
    const missing = admitted.filter((t) => !recordKeys.has(`${party}/${t.id}/${t.rev}`));
    const orphan = records.filter((r) => !admittedKeys.has(r.key));
    console.log(`\nParty ${party} (staging)`);
    console.log(`  prototype tickets created:              ${tickets[0]?.n ?? 0}`);
    console.log(`  scan outcomes:                          ${scans.map((s) => `${s.outcome}=${s.n}`).join(", ") || "none"}`);
    console.log(`  admitted tickets (main database):       ${admitted.length}`);
    console.log(`  admission records (ledger database):    ${records.length}`);
    console.log(`  admitted WITHOUT a ledger record:       ${missing.length}`);
    for (const t of missing) console.log(`    MISSING  ticket ${t.id} rev ${t.rev}`);
    console.log(`  ledger records with no admitted ticket: ${orphan.length}`);
    for (const r of orphan) console.log(`    ORPHAN   ${r.key}`);
    const pending = scans.find((s) => s.outcome === "pending");
    const ok = missing.length === 0 && orphan.length === 0 && admitted.length === records.length && !pending;
    console.log(ok ? "\nRESULT: OK. Every admitted ticket has its ledger record (same ticket id and rev)."
      : "\nRESULT: MISMATCH. Stop and send this output to Claude.");
  },

  async checkpoint() {
    const link = await ask("Door invitation link from STAGING: ");
    const phones = (await ask("Simultaneous phones [8]: ")) || "8";
    await new Promise((ok) => spawn(process.execPath, ["scripts/checkpoint-a.mjs", "--invite", link, "--scans", "50", "--phones", phones], { stdio: "inherit" }).on("close", ok));
  },
};

const [cmd, arg] = process.argv.slice(2);
if (!steps[cmd]) {
  console.error(`unknown step: ${cmd ?? ""}`);
  process.exit(2);
}
steps[cmd](arg).then(
  () => console.log("\nDone."),
  (e) => { console.error(`\nStopped: ${e.message}`); process.exit(1); },
);
