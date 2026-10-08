#!/usr/bin/env node
// Restore drill (brief: "upload, read, back up to Drive, restore into a fresh
// database, identical bytes"). Takes one backup folder downloaded from Google
// Drive and restores it into FRESH LOCAL databases; never touches Cloudflare.
//
//   node scripts/restore-drill.mjs <backup-folder> [--ledger <hourly-folder>] [--screenshots <dir>] [--keep] [--allow-incomplete]
//
//   <backup-folder>   a nightly "sahra-backup-YYYY-MM-DDTHHmmZ" folder from Drive (download it whole)
//   --ledger          a later hourly "sahra-ledger-..." folder: its change log, intents, control
//                     objects and screenshot list replace the nightly's, and the replay brings
//                     every change made after the nightly into the restored main database
//                     (this is how a restore from Drive is done: newest nightly + newest hourly)
//   --screenshots     the Drive "screenshots" folder (default: next to the backup folder)
//   --keep            keep the local databases (the path is printed) instead of deleting them
//
// Steps: apply every migration to new local databases (wrangler --local, a new
// --persist-to directory); check the backup was made with the same migrations;
// load every table (one parameterized INSERT per row) and every screenshot (one
// statement per file, the bytes bound as a BLOB: D1 statements are limited to
// 100 KB, a screenshot can be 1.5 MB); read everything back and compare with the
// backup; hash every restored screenshot; then run the recovery engine
// (src/recovery): verify that every restored row's rev is in the restored change
// log with the same state, replay (newest rev per entity wins), verify again.
// Exit code 0 only if every check passed.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { freshLocalD1, loadModules, npx, openLocalD1 } from "./lib/local-d1.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PART = /^(main|ledger|files(?:_[2-4])?)\.([a-z_]+)\.(\d{4})\.json\.gz$/;
/** Backup name of each files database and its binding in the local restore. */
const FILES_DBS = { files: "FILES", files_2: "FILES_2", files_3: "FILES_3", files_4: "FILES_4" };
/** Key of a screenshot in Drive's screenshots/index.json (database 1 keeps the bare id; same rule as Code.gs). */
const shotKey = (db, id) => (db === "files" ? String(id) : `${db}:${id}`);
const NAME = /sahra-(backup|ledger)-(\d{4}-\d{2}-\d{2}T\d{4}Z)/;

function args() {
  const [folder, ...rest] = process.argv.slice(2);
  if (!folder || folder.startsWith("--")) throw new Error("usage: restore-drill.mjs <backup-folder> [--screenshots <dir>] [--keep] [--allow-incomplete]");
  const o = { folder: resolve(folder), keep: false, allowIncomplete: false, screenshots: null, ledger: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--keep") o.keep = true;
    else if (rest[i] === "--allow-incomplete") o.allowIncomplete = true;
    else if (rest[i] === "--screenshots") o.screenshots = resolve(rest[++i]);
    else if (rest[i] === "--ledger") o.ledger = resolve(rest[++i]);
    else if (rest[i] === "--json") o.json = resolve(rest[++i]);
    else throw new Error(`unknown option ${rest[i]}`);
  }
  o.screenshots ??= join(dirname(o.folder), "screenshots");
  return o;
}

/** A nightly backup, optionally with a later hourly one supplying the ledger and the screenshot list. */
function mixedSource(base, hourly) {
  if (!hourly) return base;
  return {
    tables: [...new Set([...base.tables.filter((t) => t.startsWith("main.")), ...hourly.tables])],
    rows: (db, table) => (db === "main" ? base : hourly).rows(db, table),
    file: async (db, id) => (await hourly.file(db, id)) ?? base.file(db, id),
  };
}

/** The backup as the restore module reads it (src/backup/restore.ts BackupSource). */
function backupSource(folder, shotsDir) {
  const parts = new Map();
  for (const name of readdirSync(folder)) {
    const m = PART.exec(name);
    if (!m) continue;
    const k = `${m[1]}.${m[2]}`;
    if (!parts.has(k)) parts.set(k, []);
    parts.get(k).push(name);
  }
  const cache = new Map();
  const index = existsSync(join(folder, "files.index.json")) ? JSON.parse(readFileSync(join(folder, "files.index.json"), "utf8")).files : {};
  return {
    tables: [...parts.keys()],
    async rows(db, table) {
      const k = `${db}.${table}`;
      if (!cache.has(k)) {
        const names = (parts.get(k) ?? []).sort();
        cache.set(k, names.flatMap((n) => JSON.parse(gunzipSync(readFileSync(join(folder, n))).toString("utf8"))));
      }
      return cache.get(k);
    },
    async file(db, id) {
      const e = index[shotKey(db, id)];
      if (!e) return null;
      const p = join(shotsDir, e.name);
      if (!existsSync(p)) return null;
      return { bytes: new Uint8Array(readFileSync(p)), sha256: e.sha256 };
    },
  };
}

async function main() {
  const o = args();
  const log = (s) => console.log(s);
  const problems = [];
  const fail = (s) => { problems.push(s); log(`  PROBLEM: ${s}`); };

  log(`Restore drill: ${o.folder}${o.ledger ? `\n  with the later hourly backup ${o.ledger}` : ""}`);
  const readBackup = (folder, want) => {
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
    const kind = manifest.kind ?? "nightly";
    if (kind !== want) throw new Error(`${basename(folder)} is a ${kind} backup; expected ${want}${want === "nightly" ? " (the base must be a full sahra-backup-... folder)" : ""}`);
    const summaryPath = join(folder, "summary.json");
    if (!existsSync(summaryPath)) {
      if (!o.allowIncomplete) throw new Error(`${basename(folder)} has no summary.json: this backup did not finish (use --allow-incomplete to try anyway)`);
      log(`  (incomplete backup: no summary.json in ${basename(folder)})`);
    } else {
      const s = JSON.parse(readFileSync(summaryPath, "utf8"));
      log(`  ${s.backup}, ${s.kind}, finished ${s.finished_at}; measured sizes main ${s.database_size_bytes.main} B, ledger ${s.database_size_bytes.ledger} B, files ${s.database_size_bytes.files} B`);
      if (!s.ok) fail(`${basename(folder)}: the backup's own summary reports problems`);
    }
    return manifest;
  };
  const manifest = readBackup(o.folder, "nightly");
  const hourlyManifest = o.ledger ? readBackup(o.ledger, "hourly") : null;
  if (hourlyManifest) {
    const t = (f) => NAME.exec(basename(f))?.[2] ?? "";
    if (t(o.ledger) < t(o.folder)) fail("the hourly backup must not be older than the nightly one");
    // The schema must be the same: the ledger and screenshot list come from the hourly backup.
    for (const db of ["main", "ledger", ...Object.keys(FILES_DBS)]) {
      if (JSON.stringify(manifest.databases[db]?.migrations) !== JSON.stringify(hourlyManifest.databases[db]?.migrations)) fail(`${db}: the two backups were made with different migrations`);
    }
  }
  const nightlySrc = backupSource(o.folder, o.screenshots);
  const src = mixedSource(nightlySrc, o.ledger ? backupSource(o.ledger, o.screenshots) : null);
  const order = [...manifest.order.filter((t) => !hourlyManifest || t.db === "main"), ...(hourlyManifest?.order ?? [])];
  for (const t of order) if (!src.tables.includes(`${t.db}.${t.table}`)) fail(`no part file for ${t.db}.${t.table}`);

  const work = mkdtempSync(join(tmpdir(), "sahra-restore-drill-"));
  let mf = null;
  try {
    log(`1. fresh local databases in ${work} (wrangler --local, migrations applied)`);
    // Each files database in the backup goes into its own fresh database.
    const filesDbs = [...new Set(order.filter((t) => t.db in FILES_DBS).map((t) => t.db))];
    const bindings = ["DB", "LEDGER", ...filesDbs.map((d) => FILES_DBS[d])];
    const { persistTo, config } = freshLocalD1(ROOT, work, bindings);
    const local = await openLocalD1(ROOT, persistTo, bindings);
    mf = local.mf;
    const filesManifest = hourlyManifest ?? manifest;
    for (const [name, b, mf2] of [["main", local.DB, manifest], ["ledger", local.LEDGER, filesManifest], ...filesDbs.map((d) => [d, local[FILES_DBS[d]], filesManifest])]) {
      const have = (await b.prepare("SELECT name FROM d1_migrations ORDER BY id").all()).results.map((r) => r.name);
      const want = mf2.databases[name]?.migrations;
      if (want && JSON.stringify(have) !== JSON.stringify(want)) {
        fail(`${name}: the backup was made with migrations ${want.join(", ")}; this checkout has ${have.join(", ")}. Check out the matching commit.`);
      }
    }
    if (problems.length) throw new Error("stopped before loading");

    const m = await loadModules(ROOT, work, `
      export { loadBackup, compareRestore } from "@src/backup/restore";
      export { verify, replay } from "@src/recovery/index";
      export { D1Driver } from "@src/db/driver";`);
    const targets = {
      main: new m.D1Driver(local.DB), ledger: new m.D1Driver(local.LEDGER),
      files: Object.fromEntries(filesDbs.map((d) => [d, new m.D1Driver(local[FILES_DBS[d]])])),
    };

    log("2. loading the backup (one INSERT per row; one statement per screenshot, bytes bound as a BLOB)");
    const load = await m.loadBackup(targets, src, (l) => log(`   ${l}`));
    log(`   screenshots: ${load.files} restored (${load.file_bytes} bytes) into ${filesDbs.length} files database(s); purged by retention: ${load.purged_restored} restored from Drive, ${load.purged_without_bytes} never copied (restored as purged)`);
    for (const p of load.file_problems) fail(`screenshot ${p.db}:${p.id}: ${p.problem}`);

    log("3. reading everything back and comparing with the backup");
    const cmp = await m.compareRestore(targets, src);
    for (const [k, v] of Object.entries(cmp.tables)) {
      if (v.different) fail(`${k}: ${v.different} row(s) differ (backup ${v.backup}, restored ${v.restored})`);
    }
    log(`   ${Object.keys(cmp.tables).length} tables identical; ${cmp.blobs_checked} screenshot(s) hashed after the restore, ${cmp.blob_mismatches.length} mismatch(es); ${cmp.purged} purged (no bytes, tombstone restored)`);
    for (const id of cmp.blob_mismatches) fail(`screenshot ${id}: restored bytes hash differently`);

    // Screenshots referenced by tickets but not in the backup (a sign-up during the backup run).
    const fileIds = new Set();
    for (const d of filesDbs) for (const f of await src.rows(d, "files")) fileIds.add(`${d}:${f.id}`);
    const keyOf = (k) => { const x = /^(?:f([1-4]):|1:)?(\d+)$/.exec(String(k)); return x ? `${x[1] && x[1] !== "1" ? `files_${x[1]}` : "files"}:${x[2]}` : null; };
    const missing = (await src.rows("main", "tickets")).filter((t) => t.screenshot_key && !fileIds.has(keyOf(t.screenshot_key)));
    if (missing.length) log(`   note: ${missing.length} ticket(s) refer to a screenshot newer than this backup's file list`);

    // Independent check through wrangler itself: each database's largest screenshot, hashed from wrangler's own output.
    for (const d of filesDbs) {
      const binding = FILES_DBS[d];
      const big = await local[binding].prepare("SELECT id, size FROM files WHERE length(bytes) > 0 ORDER BY size DESC LIMIT 1").first();
      if (!big) continue;
      // hex() of the whole BLOB would be over SQLite's 2 MB string limit in D1 (SQLITE_TOOBIG): read it in 500 KB slices.
      const hash = createHash("sha256");
      for (let at = 1; at <= Number(big.size); at += 500_000) {
        const out = npx(ROOT, ["wrangler", "d1", "execute", binding, "--local", "--persist-to", persistTo, "-c", config, "--json",
          "--command", `SELECT hex(substr(bytes, ${at}, 500000)) AS h FROM files WHERE id = ${Number(big.id)}`]);
        hash.update(Buffer.from(JSON.parse(out.slice(out.search(/^\[\s*$/m)))[0].results[0].h, "hex"));
      }
      const sha = hash.digest("hex");
      const want = (await src.file(d, Number(big.id)))?.sha256;
      if (sha !== want) fail(`screenshot ${d}:${big.id} (${big.size} bytes): wrangler reads different bytes`);
      else log(`   ${d}: largest screenshot (${big.size} bytes) read back through wrangler: SHA-256 identical`);
    }

    log("4. recovery engine (src/recovery): restored database against the restored change log");
    const before = await m.verify(targets.main, targets.ledger);
    log(`   verify: ${before.rows} rows, ${before.mismatches.length} mismatch(es)`);
    const r = await m.replay(targets.main, targets.ledger);
    log(`   replay: ${r.applied} newer change(s) applied from the change log, ${r.unchanged} already current, ${r.holds.length} hold(s)`);
    for (const h of r.holds) log(`     HOLD ${h.entity} ${h.id} (party ${h.party_id}): ${h.reason}`);
    const after = await m.verify(targets.main, targets.ledger);
    if (!after.ok) for (const x of after.mismatches.slice(0, 20)) fail(`after replay: ${x.entity} ${x.id} ${x.problem}`);
    log(`   verify after replay: ${after.ok ? "OK, every row matches the change log" : `${after.mismatches.length} mismatch(es)`}`);
    if (r.holds.length) log("   (holds are what a controlled recovery would put on hold for the owner; the drill reports them, it does not fail on them)");
    if (o.json) writeFileSync(o.json, JSON.stringify({ applied: r.applied, holds: r.holds.length, verify_before: before.mismatches.length, verify_after_ok: after.ok,
      files_dbs: filesDbs, files: load.files, purged_restored: load.purged_restored, purged_without_bytes: load.purged_without_bytes, blobs_checked: cmp.blobs_checked }));
  } finally {
    if (mf) await mf.dispose();
    if (o.keep) log(`kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log(`\nRestore drill FAILED: ${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log(`\nRestore drill OK: ${basename(o.folder)} restored into fresh local databases; rows and screenshot bytes identical.`);
}

main().catch((e) => {
  console.error(`\nRestore drill stopped: ${e.message}`);
  process.exit(1);
});
