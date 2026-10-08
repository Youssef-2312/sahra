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
//   node scripts/ops.mjs create-site-owner
//   node scripts/ops.mjs checkpoint
//   node scripts/ops.mjs verify-ledger          (read-only, staging)
//   node scripts/ops.mjs measure-cpu            (staging)
//   node scripts/ops.mjs revoke-door-staging    (staging)

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { siteOwnerSql } from "./site-owner-sql.mjs";

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
      // Every staging-only SQL file, in name order; each is safe to run again.
      for (const [db, dir] of [["DB", "migrations-staging/main"], ["LEDGER", "migrations-staging/ledger"]]) {
        for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
          await wrangler(["d1", "execute", db, "--remote", ...e, "--file", `${dir}/${f}`]);
        }
      }
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

  // Adds the first (or another) site owner by email. They then sign in at
  // /platform with that Google account within 14 days; the first sign-in links it.
  // Runs again safely: an existing site owner with that email is not duplicated (an
  // unlinked one gets a fresh 14 days).
  async "create-site-owner"() {
    const name = (await ask("Environment (staging/prod): ")).toLowerCase();
    const e = envArg(name);
    const { email, statements } = siteOwnerSql({
      name: await ask("Site owner name: "), email: await ask("Site owner Gmail (or Google Workspace) address: "),
      id: randomUUID(), op: randomUUID(), now: Date.now(),
    });
    await confirmProd(name, `add site owner ${email}`);
    const dir = mkdtempSync(join(tmpdir(), "sahra-"));
    const file = join(dir, "site-owner.sql");
    writeFileSync(file, statements.join("\n"));
    try {
      await wrangler(["d1", "execute", "DB", "--remote", ...e, "--file", file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const r = await wrangler(["d1", "execute", "DB", "--remote", ...e, "--json", "--command",
      `SELECT name, email, google_sub IS NOT NULL AS linked, invite_expires_at FROM platform_admins WHERE email = '${email.replace(/'/g, "''")}' AND disabled_at IS NULL`], { quiet: true });
    console.log(/"email"/.test(r.stdout) ? `\nSite owner ${email} is set up on ${name}. Sign in at /platform with that Google account.` : "\nCould not confirm the row; run this step again.");
  },

  // Read-only: every admission in the main database (scan rows with outcome
  // "admitted": ticket id + the ticket's rev at admission) must have its ledger
  // record (change_log event "ticket:<id>:<rev>"). A missing record means a scan
  // whose green-screen step never finished: it never showed green, and recovery
  // must resolve that ticket (section 8.3).
  async "verify-ledger"() {
    const party = ((await ask("Party id [checkpoint-a]: ")) || "checkpoint-a").replace(/[^a-z0-9-]/g, "");
    const query = async (db, sql) => {
      const r = await wrangler(["d1", "execute", db, "--remote", "--env", "staging", "--json", "--command", sql], { quiet: true });
      // The JSON result starts on its own line ("[" alone); anything before it is wrangler chatter.
      const start = r.stdout.search(/^\[\s*$/m);
      if (start < 0) throw new Error("could not read the query result");
      return JSON.parse(r.stdout.slice(start))[0].results;
    };
    const admitted = await query("DB", `SELECT ticket_id, ticket_rev FROM scans WHERE party_id = '${party}' AND outcome = 'admitted'`);
    const outcomes = await query("DB", `SELECT outcome, COUNT(*) AS n FROM scans WHERE party_id = '${party}' GROUP BY outcome`);
    const used = await query("DB", `SELECT COUNT(*) AS n FROM tickets WHERE party_id = '${party}' AND used_scan_id IS NOT NULL`);
    const records = await query("LEDGER", `SELECT entity_id, rev FROM change_log WHERE party_id = '${party}' AND entity = 'ticket' AND action = 'admitted'`);
    const recordKeys = new Set(records.map((r) => `${r.entity_id}:${r.rev}`));
    const admittedKeys = new Set(admitted.map((a) => `${a.ticket_id}:${a.ticket_rev}`));
    const missing = admitted.filter((a) => !recordKeys.has(`${a.ticket_id}:${a.ticket_rev}`));
    const orphan = records.filter((r) => !admittedKeys.has(`${r.entity_id}:${r.rev}`));
    console.log(`\nParty ${party} (staging)`);
    console.log(`  scan outcomes:                          ${outcomes.map((s) => `${s.outcome}=${s.n}`).join(", ") || "none"}`);
    console.log(`  tickets marked used (main database):    ${used[0]?.n ?? 0}`);
    console.log(`  admissions (main database scan rows):   ${admitted.length}`);
    console.log(`  admission records (ledger database):    ${records.length}`);
    console.log(`  admissions WITHOUT a ledger record:     ${missing.length}`);
    for (const m of missing) console.log(`    MISSING  ticket ${m.ticket_id} rev ${m.ticket_rev}`);
    console.log(`  ledger records with no admission row:   ${orphan.length}`);
    for (const o of orphan) console.log(`    ORPHAN   ticket ${o.entity_id} rev ${o.rev}`);
    const ok = missing.length === 0 && orphan.length === 0 && admitted.length === records.length;
    console.log(ok ? "\nRESULT: OK. Every admission has its ledger record (same ticket id and rev)."
      : "\nRESULT: MISMATCH. Stop and send this output to Claude.");
  },

  // STAGING ONLY: revoke every door invitation of a party and end every door
  // session in one main-database batch (with audit rows), then write each changed
  // invitation's full state to the ledger (change log, entity + rev) and mark it
  // logged, as the dashboard's "revoke invite" does. Every run first finishes any
  // revocation that is not yet in the ledger, so it is safe to run again.
  //
  // Reads use --command (remote --file returns only a summary, not rows); writes
  // use a temporary --file (one transaction; a failure changes nothing).
  async "revoke-door-staging"() {
    const party = ((await ask("Party id [checkpoint-a]: ")) || "checkpoint-a").replace(/[^a-z0-9-]/g, "");
    const sq = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
    const select = async (db, sql) => {
      const r = await wrangler(["d1", "execute", db, "--remote", "--env", "staging", "--json", "--command", sql], { quiet: true });
      const start = r.stdout.search(/^\[\s*$/m);
      if (start < 0) throw new Error("could not read the query result");
      return JSON.parse(r.stdout.slice(start))[0].results;
    };
    const write = async (db, statements) => {
      const dir = mkdtempSync(join(tmpdir(), "sahra-"));
      const file = join(dir, "q.sql");
      writeFileSync(file, statements.join("\n"));
      try {
        await wrangler(["d1", "execute", db, "--remote", "--env", "staging", "--file", file], { quiet: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // Revoked invitations whose latest rev is not yet confirmed in the ledger.
    const pendingRows = () => select("DB", `SELECT * FROM invites WHERE party_id = '${party}' AND kind = 'door' AND revoked_at IS NOT NULL AND rev > logged_rev`);
    const finishLedger = async () => {
      const rows = await pendingRows();
      if (rows.length === 0) return 0;
      for (const r of rows) {
        if (typeof r.id !== "string" || !Number.isInteger(r.rev)) throw new Error("unexpected row shape; nothing written to the ledger");
      }
      const now = Date.now();
      await write("LEDGER", rows.map((r) => {
        const { logged_rev: _ignored, ...state } = r;
        return `INSERT INTO change_log (event_id, party_id, entity, entity_id, rev, action, logged_at, state) VALUES (${sq(`invite:${r.id}:${r.rev}`)}, ${sq(r.party_id)}, 'invite', ${sq(r.id)}, ${r.rev}, ${sq(r.last_action ?? "invite_revoked")}, ${now}, ${sq(JSON.stringify(state))}) ON CONFLICT (event_id) DO NOTHING;`;
      }));
      // Confirm every record is in the ledger before marking anything logged.
      const ids = rows.map((r) => sq(`invite:${r.id}:${r.rev}`)).join(", ");
      const found = new Set((await select("LEDGER", `SELECT event_id FROM change_log WHERE event_id IN (${ids})`)).map((x) => x.event_id));
      const confirmed = rows.filter((r) => found.has(`invite:${r.id}:${r.rev}`));
      if (confirmed.length) {
        await write("DB", confirmed.map((r) => `UPDATE invites SET logged_rev = ${r.rev} WHERE id = ${sq(r.id)} AND logged_rev < ${r.rev};`));
      }
      if (confirmed.length !== rows.length) throw new Error(`${rows.length - confirmed.length} ledger record(s) not confirmed; run step 13 again`);
      return confirmed.length;
    };

    const finished = await finishLedger();
    if (finished) console.log(`Recorded ${finished} earlier revocation(s) in the ledger.`);

    const open = (await select("DB", `SELECT COUNT(*) AS n FROM invites WHERE party_id = '${party}' AND kind = 'door' AND revoked_at IS NULL`))[0]?.n ?? 0;
    const sessions = (await select("DB", `SELECT COUNT(*) AS n FROM sessions WHERE party_id = '${party}' AND kind = 'door' AND revoked_at IS NULL`))[0]?.n ?? 0;
    console.log(`\nStaging party ${party}: ${open} door invitation(s) not yet revoked, ${sessions} door session(s) active.`);
    if (open === 0 && sessions === 0) { console.log("Nothing left to revoke."); return; }
    if ((await ask("Type YES to revoke all of them: ")) !== "YES") throw new Error("cancelled");
    const now = Date.now();
    const op = `ops-revoke-${now}`;
    await write("DB", [
      `UPDATE invites SET revoked_at = ${now}, revoked_by = 'operator', rev = rev + 1, last_op = '${op}', last_action = 'invite_revoked' WHERE party_id = '${party}' AND kind = 'door' AND revoked_at IS NULL;`,
      `UPDATE sessions SET revoked_at = ${now} WHERE party_id = '${party}' AND kind = 'door' AND revoked_at IS NULL;`,
      `INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail) SELECT party_id, ${now}, NULL, 'invite_revoked', 'invite', id, rev, 'operator script (staging)' FROM invites WHERE last_op = '${op}';`,
    ]);
    const logged = await finishLedger();
    const left = (await select("DB", `SELECT COUNT(*) AS n FROM sessions WHERE party_id = '${party}' AND kind = 'door' AND revoked_at IS NULL`))[0]?.n ?? 0;
    console.log(`\nRevoked and recorded ${logged} invitation(s) in the ledger. Door sessions still active: ${left}.`);
  },

  // Live CPU per endpoint, cold vs warm, on staging (wrangler tail + live-check traffic).
  async "measure-cpu"() {
    await new Promise((ok) => spawn(process.execPath, ["scripts/measure-cpu.mjs"], { stdio: "inherit" }).on("close", ok));
  },

  async checkpoint() {
    const link = await ask("Door invitation link from STAGING: ");
    await new Promise((ok) => spawn(process.execPath, ["scripts/live-check.mjs", "--invite", link], { stdio: "inherit" }).on("close", ok));
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
