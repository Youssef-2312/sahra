#!/usr/bin/env node
// Controlled recovery procedure (brief section 8.3), run by the owner with the
// owner's own Cloudflare login. "All restores must go through the controlled
// recovery procedure." Only the owner's credential can restore the database; no
// Worker and no party owner can.
//
//   node scripts/recover.mjs staging          rehearse on staging first
//   node scripts/recover.mjs prod             production (asks you to type PROD)
//   node scripts/recover.mjs local --persist-to <dir> --restore-sql <file>
//                                             local rehearsal (no Cloudflare)
//
// Steps (each safe to run again; if anything stops, run the script again):
//   0. Maintenance on: every API request answers 503 (scanners: can't verify).
//   1. Pause every party (control objects).
//   2. Copy every change and admission not yet in the ledger into it; check they match.
//   3. Restore the main database with Time Travel, to a time you choose.
//   4. Replay the change log (newest rev per entity wins).
//   5. Hold anything unconfirmed; end every session; revoke every unused invitation.
//   6. Set each party's pause_number to its control object's. Maintenance off.
// Parties stay PAUSED until an owner or admin presses "Open admission".

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { wranglerDriver, wranglerOnce } from "./lib/d1-wrangler.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENVS = { staging: ["--env", "staging"], prod: ["--env="] };
const APP_TABLES_DELETE_ORDER = ["sessions", "scans", "outbox", "audit", "tickets", "invites", "staff", "parties"];

async function ask(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

function origins() {
  // wrangler.jsonc without comments and trailing commas.
  const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  const cfg = JSON.parse(text);
  return { prod: cfg.vars.PUBLIC_ORIGIN, staging: cfg.env.staging.vars.PUBLIC_ORIGIN };
}

async function loadEngine() {
  const dir = mkdtempSync(join(tmpdir(), "sahra-recovery-"));
  const out = join(dir, "recovery.mjs");
  // esbuild's JS API (no shell, no child process arguments).
  const { build } = await import("esbuild");
  await build({ entryPoints: [join(ROOT, "src/recovery/procedure.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
  const mod = await import(pathToFileURL(out).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

async function maintenanceState(origin) {
  try {
    const r = await fetch(`${origin}/api/me`, { signal: AbortSignal.timeout(10000) });
    const body = await r.json().catch(() => ({}));
    return r.status === 503 && body.error === "maintenance";
  } catch {
    return null;
  }
}

async function waitFor(origin, want) {
  for (let i = 0; i < 18; i++) {
    if ((await maintenanceState(origin)) === want) return true;
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  return false;
}

async function main() {
  const [target, ...rest] = process.argv.slice(2);
  const opt = Object.fromEntries(rest.reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
  const local = target === "local";
  if (!local && !(target in ENVS)) throw new Error("usage: recover.mjs staging | prod | local --persist-to <dir> --restore-sql <file>");
  if (local && (!opt["persist-to"] || !opt["restore-sql"])) throw new Error("local needs --persist-to and --restore-sql");
  const env = local ? ["--env", "staging"] : ENVS[target];
  const origin = local ? null : origins()[target];

  console.log(`\nControlled recovery on ${local ? "a LOCAL rehearsal database" : target.toUpperCase()}${origin ? ` (${origin})` : ""}.`);
  console.log("Every party is paused, every session ends and every unused invitation is revoked. Parties stay paused until reopened.");
  if (target === "prod" && (await ask("This is PRODUCTION. Type PROD to continue: ")) !== "PROD") throw new Error("cancelled");
  if ((await ask("Type RECOVER to start: ")) !== "RECOVER") throw new Error("cancelled");

  const { recover } = await loadEngine();
  const d = (binding) => wranglerDriver({ binding, env, local, persistTo: opt["persist-to"] });

  // 0. Maintenance on.
  if (!local) {
    console.log("\n0. Maintenance on (secret MAINTENANCE = 1)...");
    const r = await wranglerOnce(["secret", "put", "MAINTENANCE", ...env], { input: "1" });
    if (r.code !== 0) throw new Error("could not set MAINTENANCE");
    if (!(await waitFor(origin, true))) {
      throw new Error("the Worker does not answer 'maintenance' yet; nothing else was changed. Run again in a minute.");
    }
    console.log("   every API request now answers 503 maintenance");
    const info = await wranglerOnce(["d1", "time-travel", "info", "DB", ...env, "--json"]);
    if (info.code === 0) console.log(`   current Time Travel bookmark (to undo the restore): ${info.stdout.trim()}`);
  }

  const restore = async () => {
    if (local) {
      const sqlText = readFileSync(opt["restore-sql"], "utf8");
      const dir = mkdtempSync(join(tmpdir(), "sahra-restore-"));
      const file = join(dir, "restore.sql");
      writeFileSync(file, `${APP_TABLES_DELETE_ORDER.map((t) => `DELETE FROM ${t};`).join("\n")}\n${sqlText}`);
      try {
        const r = await wranglerOnce(["d1", "execute", "DB", "--local", "--persist-to", opt["persist-to"], ...env, "--file", file]);
        if (r.code !== 0) throw new Error(`local restore failed:\n${r.out.slice(-500)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return;
    }
    console.log("\n3. Restore the main database (Time Travel, last 30 days).");
    const at = await ask("   Restore to which moment? An RFC3339 time such as 2026-10-08T01:00:00Z, or a bookmark, or 'none' to skip: ");
    if (at === "none") { console.log("   no restore; replaying onto the current database"); return; }
    if ((await ask(`   Type RESTORE to restore ${target} DB to ${at}: `)) !== "RESTORE") throw new Error("restore cancelled; the ledger is complete and maintenance is still on; run again");
    const flag = /^[0-9a-f-]{20,}$/i.test(at) && !/T/.test(at) ? `--bookmark=${at}` : `--timestamp=${at}`;
    const r = await wranglerOnce(["d1", "time-travel", "restore", "DB", ...env, flag], { interactive: true });
    if (r.code !== 0) throw new Error("Time Travel restore failed; maintenance is still on; run again");
  };

  const report = await recover({ main: d("DB"), ledger: d("LEDGER"), now: () => Date.now(), restore, log: (l) => console.log(`${l.match(/^\d\./) ? "\n" : "   "}${l}`) });

  if (!report.finalOk) {
    console.log("\nThe final check found mismatches. Maintenance stays ON. Run the script again; if it repeats, send the output to Claude.");
    process.exit(1);
  }
  if (!local) {
    console.log("\nMaintenance off...");
    const r = await wranglerOnce(["secret", "delete", "MAINTENANCE", ...env], { input: "y\n" });
    if (r.code !== 0 || !(await waitFor(origin, false))) console.log("   could not confirm; remove it by hand: npx wrangler secret delete MAINTENANCE " + env.join(" "));
  }
  console.log(`\nDone. ${report.held} item(s) on hold (owners resolve them on the dashboard's Recovery section).`);
  console.log("Every party is PAUSED: an owner or admin presses \"Open admission\" when ready.");
  for (const h of report.holds) console.log(`  HOLD ${h.entity} ${h.id} (party ${h.party_id}): ${h.reason}`);
}

main().catch((e) => {
  console.error(`\nStopped: ${e.message}`);
  console.error("If maintenance was turned on, it stays ON (scanners say can't verify). Every step is safe to repeat: run the script again.");
  process.exit(1);
});
