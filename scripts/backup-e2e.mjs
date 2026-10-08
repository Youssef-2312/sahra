#!/usr/bin/env node
// Local end-to-end test of the whole backup path, without Cloudflare or Google:
//
//   1. fresh local D1 databases (wrangler --local, a new --persist-to directory)
//   2. the Worker (src/index.ts) running locally in Miniflare on those databases,
//      with a random BACKUP_KEY and random test-only master secrets
//   3. data made through the real routes: tickets, an admission, guest sign-ups
//      with screenshots (one of exactly 1.5 MB), approval, release, a cancel
//   4. backup/apps-script/Code.gs itself, run in a simulation of Apps Script
//      (scripts/lib/apps-script-sim.mjs) with a tiny time limit per run, so the
//      backup needs many runs and resumes each time; Drive is a local folder
//      (the first backup is the nightly, full one); it reports to POST /api/backup/done
//   5. changes after the nightly (admissions, a cancel, a new sign-up with its
//      screenshot, an approval), then an HOURLY backup: ledger + screenshot list,
//      only the new screenshot copied
//   6. scripts/restore-drill.mjs: the nightly alone, then nightly + hourly
//      (--ledger): fresh databases, identical rows and screenshot bytes, and the
//      changes made after the nightly come back through the recovery replay
//   7. the drill must FAIL on a backup whose screenshot copy was altered
//   8. past workstream F's daily budget the hourly backup is skipped, never the nightly
//   9. a wrong key: the run fails and the owner gets an alert email (simulated)
//
//   node scripts/backup-e2e.mjs [--keep]

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { loadAppsScript } from "./lib/apps-script-sim.mjs";
import { freshLocalD1, LOCAL_IDS, loadModules } from "./lib/local-d1.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://sahra.test";
const keep = process.argv.includes("--keep");
const b64 = (n) => randomBytes(n).toString("base64url");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`  ok: ${what}`); };

async function main() {
  const work = mkdtempSync(join(tmpdir(), "sahra-backup-e2e-"));
  const workerLog = [];
  let mf = null;
  let sim = null;
  try {
    console.log(`1. fresh local databases in ${work}`);
    const { persistTo } = freshLocalD1(ROOT, join(work, "live"));

    console.log("2. the Worker in Miniflare");
    const esbuild = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
    const bundle = join(work, "worker.mjs");
    execFileSync(esbuild, [join(ROOT, "src", "index.ts"), "--bundle", "--format=esm", "--platform=browser", "--conditions=workerd,worker,browser",
      "--external:cloudflare:*", `--outfile=${bundle}`, "--log-level=error"], { shell: process.platform === "win32" });
    const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(join(ROOT, "node_modules", "miniflare", "dist", "src", "index.js")).href);
    const backupKey = b64(32);
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, scriptPath: bundle, modulesRoot: work, compatibilityDate: "2026-08-01",
      resourcePersistencePath: join(persistTo, "v3"), d1Databases: LOCAL_IDS,
      // The Worker's request log lines: kept to count rows read by the backup.
      handleStructuredLogs: (l) => { workerLog.push(l.message); if (process.env.E2E_DEBUG) console.log(JSON.stringify(l).slice(0, 200)); },
      bindings: {
        PUBLIC_ORIGIN: ORIGIN, GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", ENABLE_TEST_TICKETS: "1",
        QR_MASTER_K1: b64(32), COOKIE_MASTER_K1: b64(32), LINK_MASTER_K1: b64(32), BACKUP_KEY: backupKey,
        // Cloudflare's documented always-pass Turnstile test keys (accepted only with ENABLE_TEST_TICKETS = "1").
        TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
      },
      ratelimits: {
        RL_AUTH: { namespace_id: "1", simple: { limit: 100000, period: 60 } },
        RL_SCAN: { namespace_id: "2", simple: { limit: 100000, period: 60 } },
      },
      // No real network: siteverify answers like Cloudflare does for the test keys.
      outboundService: async (req) => req.url.startsWith("https://challenges.cloudflare.com/")
        ? new Response(JSON.stringify({ success: true, hostname: "sahra.test", action: "", "error-codes": [] }), { headers: { "content-type": "application/json" } })
        : new Response("no network in this test", { status: 502 }),
    }));
    const url = await mf.ready;
    const DB = await mf.getD1Database("DB");
    const LEDGER = await mf.getD1Database("LEDGER");
    const FILES = await mf.getD1Database("FILES");

    console.log("3. data through the real routes");
    const call = async (path, init = {}) => {
      const r = await mf.dispatchFetch(`${ORIGIN}${path}`, init);
      const text = await r.text();
      return { status: r.status, body: text.startsWith("{") ? JSON.parse(text) : text };
    };
    const session = async (party, role) => {
      const staff = crypto.randomUUID();
      await DB.prepare("INSERT INTO staff (id, party_id, name, role, google_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(staff, party, `Staff ${role}`, role, `sub-${staff}`, Date.now()).run();
      const token = b64(32);
      const hash = sha(token);
      await DB.prepare("INSERT INTO sessions (id_hash, kind, party_id, staff_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(hash, role === "door" ? "door" : "google", party, staff, role, Date.now(), Date.now() + 3600_000).run();
      const csrf = createHash("sha256").update(Buffer.concat([Buffer.from("sahra-csrf-v2|"), Buffer.from(token, "base64url")])).digest("base64url");
      return (path, body) => call(path, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "x-sahra-csrf": csrf, cookie: `__Host-sahra_s=${token}` }, body: JSON.stringify(body) });
    };
    await DB.prepare("INSERT INTO parties (id, name, capacity, max_people_per_ticket, created_at) VALUES ('drill-party', 'Drill party', 500, 4, ?)").bind(Date.now()).run();
    const owner = await session("drill-party", "owner");
    const door = await session("drill-party", "door");
    check((await owner("/api/admission", { action: "open" })).status === 200, "admission opened");
    const made = await owner("/api/test/tickets", { count: 12, people: 1 });
    check(made.status === 200 && made.body.tickets.length === 12, "12 tickets created");
    for (const t of made.body.tickets.slice(0, 3)) {
      check((await door("/api/scan", { scan_id: crypto.randomUUID(), qr: t.qr })).body.verdict === "admit", "a guest admitted");
    }
    const signupOne = async (size) => {
      const shot = randomBytes(size);
      shot.set([0xff, 0xd8, 0xff, 0xe0]);
      const fd = new FormData();
      fd.set("signup", b64(32));
      fd.set("name", "Guest Name");
      fd.set("email", `guest-${b64(4)}@example.com`);
      fd.set("people", "1");
      fd.set("screenshot", new File([shot], "shot.jpg", { type: "image/jpeg" }));
      fd.set("cf-turnstile-response", "XXXX.DUMMY.TOKEN.XXXX");
      const req = new Request(`${ORIGIN}/x`, { method: "POST", body: fd });
      const body = new Uint8Array(await req.arrayBuffer());
      const r = await call("/api/guest/parties/drill-party/signup", { method: "POST", body, headers: { origin: ORIGIN, "content-type": req.headers.get("content-type"), "content-length": String(body.length) } });
      if (r.status !== 201) throw new Error(`sign-up ${r.status} ${JSON.stringify(r.body)}`);
      return { id: r.body.ticket_id, sha: sha(shot), size };
    };
    const shots = [];
    for (const size of [1500, 48_000, 210_000, 1_500_000]) shots.push(await signupOne(size));
    check(shots.length === 4, "4 sign-ups with screenshots (largest exactly 1,500,000 bytes)");
    check((await owner("/api/tickets/approve", { ids: shots.slice(0, 3).map((s) => s.id) })).status === 200, "3 approved");
    check((await owner("/api/tickets/release", { ids: shots.slice(0, 1).map((s) => s.id) })).status === 200, "1 released");
    check((await owner(`/api/tickets/${shots[2].id}/cancel`, { op: crypto.randomUUID() })).status === 200, "1 cancelled (with its intent)");
    // The party, its staff and the drill's sessions were inserted directly: log them as a route would have.
    const eng = await loadModules(ROOT, work, `export { flushAll } from "@src/recovery/index"; export { D1Driver } from "@src/db/driver";`);
    await eng.flushAll(new eng.D1Driver(DB), new eng.D1Driver(LEDGER), Date.now());

    console.log("4. Code.gs in the Apps Script simulation (a 60 ms limit per run, so it resumes many times)");
    const drive = join(work, "drive");
    mkdirSync(drive);
    const code = readFileSync(join(ROOT, "backup", "apps-script", "Code.gs"), "utf8");
    const props = { BACKUP_URL: url.origin, BACKUP_KEY: backupKey, FOLDER_ID: "root" };
    sim = loadAppsScript({ code, driveDir: drive, props, overrides: { RUN_LIMIT_MS: 60, PAGE: 3, PART_ROWS: 7, FILE_BATCH: 1 } });
    const s = sim.call("setup");
    check(s.frequency === "hourly", `the Worker says hourly (${s.reasons.join("; ")})`);
    check(sim.triggers.some((t) => t.handler === "hourly" && t.everyHours === 1), "hourly trigger installed");
    const runAll = (first) => {
      let runs = 0;
      let r = sim.call(first);
      for (runs = 1; r === "continues" && runs < 500; runs++) r = sim.call("continueBackup");
      if (r !== "done") throw new Error(`backup ended with ${r}: ${sim.props.get("LAST_ERROR")}`);
      return runs;
    };
    const logStart = workerLog.length;
    const runs1 = runAll("hourly");
    // The simulated script blocks this thread while it runs; let the Worker's log lines arrive.
    await new Promise((ok) => setTimeout(ok, 500));
    const usage = workerLog.slice(logStart).filter((l) => l.startsWith('{"evt":"backup"')).map((l) => JSON.parse(l));
    const read = usage.reduce((a, x) => a + x.main_rows_read + x.ledger_rows_read + x.files_rows_read, 0);
    const written = usage.reduce((a, x) => a + x.rows_written, 0);
    check(usage.filter((x) => x.route !== "/api/backup/done").every((x) => x.rows_written === 0) && written === 1,
      `the export wrote nothing; the final report wrote 1 row (${usage.length} requests, ${read} rows read in total)`);
    check(runs1 > 1, `first backup finished after ${runs1} runs (resumed from Script Properties)`);
    check(!sim.triggers.some((t) => t.handler === "continueBackup"), "no continuation trigger left");
    const folders = () => readdirSync(drive).filter((n) => n.startsWith("sahra-backup-")).sort();
    const first = folders();
    check(first.length === 1, `one nightly (full) folder: ${first[0]}`);
    const health = () => DB.prepare("SELECT last_backup_at, last_backup_note FROM health_state WHERE id = 'main'").first();
    const h1 = await health();
    check(h1.last_backup_at !== null && h1.last_backup_note.startsWith(`nightly ${first[0]}:`), `reported to the Worker (health_state: ${h1.last_backup_note})`);
    const sum1 = JSON.parse(readFileSync(join(drive, first[0], "summary.json"), "utf8"));
    check(sum1.ok && sum1.screenshots.copied === 4 && sum1.screenshots.failed === 0, "4 screenshots copied, each verified by size and SHA-256 (and read back from Drive)");
    check(sum1.database_size_bytes.main > 0 && sum1.database_size_bytes.files > 1_500_000, `summary holds measured sizes (main ${sum1.database_size_bytes.main} B, files ${sum1.database_size_bytes.files} B)`);
    const index = JSON.parse(readFileSync(join(drive, "screenshots", "index.json"), "utf8"));
    for (const shot of shots) {
      const fid = Number((await DB.prepare("SELECT screenshot_key FROM tickets WHERE id = ?").bind(shot.id).first("screenshot_key")).split(":")[1]);
      const e = index.files[String(fid)];
      check(e && e.sha256 === shot.sha && sha(readFileSync(join(drive, "screenshots", e.name))) === shot.sha, `screenshot of ${shot.size} bytes in Drive: same SHA-256 as uploaded`);
    }

    console.log("5. changes after the nightly, then an hourly backup (ledger + new screenshots)");
    const later = made.body.tickets.slice(3, 5);
    for (const t of later) check((await door("/api/scan", { scan_id: crypto.randomUUID(), qr: t.qr })).body.verdict === "admit", "a guest admitted after the nightly");
    check((await owner(`/api/tickets/${made.body.tickets[6].id}/cancel`, { op: crypto.randomUUID() })).status === 200, "a ticket cancelled after the nightly");
    const newShot = await signupOne(90_000);
    check((await owner("/api/tickets/approve", { ids: [newShot.id] })).status === 200, "a new sign-up approved after the nightly");
    // The nightly is not due again (it ran just now); the last backup was "2 hours ago".
    sim.props.set("LAST_SUCCESS_AT", String(Date.now() - 2 * 3600_000));
    const fetchesBefore = sim.fetches;
    const runs2 = runAll("hourly");
    const hourlyName = readdirSync(drive).find((n) => n.startsWith("sahra-ledger-"));
    check(Boolean(hourlyName) && !readdirSync(drive).some((n) => n.startsWith("INCOMPLETE")), `hourly backup complete: ${hourlyName}`);
    const sum2 = JSON.parse(readFileSync(join(drive, hourlyName, "summary.json"), "utf8"));
    check(sum2.kind === "hourly" && Object.keys(sum2.rows).every((k) => !k.startsWith("main.")), `only the ledger and the screenshot list (${Object.keys(sum2.rows).join(", ")})`);
    check(sum2.screenshots.copied === 1 && sum2.screenshots.alreadyCopied === 4, `only the new screenshot copied (${runs2} runs, ${sim.fetches - fetchesBefore} requests)`);
    const h2 = await health();
    check(h2.last_backup_at > h1.last_backup_at - 3600_000 && h2.last_backup_note.startsWith(`hourly ${hourlyName.replace(/~\d+$/, "")}:`), "hourly backup reported");

    console.log("6. restore drill: the nightly alone, then nightly + hourly");
    const drill = (args, root = drive) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [join(ROOT, "scripts", "restore-drill.mjs"), ...args, "--screenshots", join(root, "screenshots")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e) {
        return { code: e.status, out: `${e.stdout}${e.stderr}` };
      }
    };
    const show = (r) => console.log(r.out.split("\n").map((l) => `    | ${l}`).join("\n"));
    const alone = drill([join(drive, first[0])]);
    check(alone.code === 0, "restore drill on the nightly alone passed");
    const outJson = join(work, "drill.json");
    const both = drill([join(drive, first[0]), "--ledger", join(drive, hourlyName), "--keep", "--json", outJson]);
    show(both);
    check(both.code === 0, "restore drill on nightly + hourly passed");
    const dj = JSON.parse(readFileSync(outJson, "utf8"));
    check(dj.applied >= 4 && dj.holds === 0 && dj.verify_after_ok, `the replay applied ${dj.applied} change(s) made after the nightly, 0 holds, every row matches the change log`);
    const kept = /kept: (.*)/.exec(both.out)[1].trim();
    const { openLocalD1 } = await import(pathToFileURL(join(ROOT, "scripts", "lib", "local-d1.mjs")).href);
    const restored = await openLocalD1(ROOT, join(kept, "state"));
    try {
      for (const t of later) check((await restored.DB.prepare("SELECT used_at FROM tickets WHERE id = ?").bind(t.id).first("used_at")) !== null, `ticket admitted after the nightly is admitted in the restore`);
      check((await restored.DB.prepare("SELECT status FROM tickets WHERE id = ?").bind(made.body.tickets[6].id).first("status")) === "cancelled", "ticket cancelled after the nightly is cancelled in the restore");
      const nt = await restored.DB.prepare("SELECT status, screenshot_key FROM tickets WHERE id = ?").bind(newShot.id).first();
      check(nt?.status === "approved", "sign-up made after the nightly exists, approved, in the restore");
      const blob = await restored.FILES.prepare("SELECT bytes FROM files WHERE id = ?").bind(Number(nt.screenshot_key.split(":")[1])).first("bytes");
      check(sha(Buffer.from(blob)) === newShot.sha, "its screenshot (copied by the hourly backup) restored byte-identical");
    } finally {
      await restored.mf.dispose();
      rmSync(kept, { recursive: true, force: true });
    }
    check(drill([join(drive, hourlyName)]).code === 1, "the drill refuses an hourly folder as the base");

    console.log("7. the drill catches an altered screenshot copy");
    const bad = join(work, "bad");
    cpSync(drive, bad, { recursive: true });
    const victim = index.files[Object.keys(index.files)[0]];
    const p = join(bad, "screenshots", victim.name);
    const bytes = readFileSync(p);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(p, bytes);
    const badRun = drill([join(bad, first[0])], bad);
    check(badRun.code === 1 && /do not match the recorded SHA-256/.test(badRun.out), "drill FAILS when a screenshot copy differs by one byte");

    console.log("8. past the daily budget: hourly skipped, nightly not");
    const day = Math.floor(Date.now() / 86_400_000);
    await DB.prepare("UPDATE health_state SET usage_day = ?, usage_est = 50000 WHERE id = 'main'").bind(day).run();
    sim.props.set("LAST_SUCCESS_AT", String(Date.now() - 2 * 3600_000));
    const foldersBefore = readdirSync(drive).length;
    check(sim.call("hourly") === "skipped_budget" && readdirSync(drive).length === foldersBefore, "hourly backup skipped while the budget says stop");
    sim.props.set("LAST_FULL_AT", String(Date.now() - 27 * 3600_000));
    check(runAll("hourly") >= 1 && JSON.parse(readFileSync(join(drive, folders().filter((n) => n.startsWith("sahra-backup-")).at(-1), "summary.json"), "utf8")).kind === "nightly",
      "the nightly backup still runs past the budget");
    await DB.prepare("UPDATE health_state SET usage_day = 0, usage_est = 0 WHERE id = 'main'").run();

    console.log("9. a wrong key: the run fails and the owner is alerted");
    sim.props.set("BACKUP_KEY", b64(32));
    sim.props.set("LAST_SUCCESS_AT", "0");
    const r = sim.call("hourly");
    check(r === "failed" && sim.mails.length === 1 && /Sahra backup failed/.test(sim.mails[0].subject) && sim.mails[0].to === "owner@example.com", "failed run, one alert email to the account's own address");
    check(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(JSON.stringify(sim.mails)), "no emojis in the alert");

    console.log("\nBackup end-to-end test OK (local only: Miniflare, a simulated Apps Script, a Drive folder on disk).");
  } finally {
    sim?.http.close();
    if (mf) await mf.dispose();
    if (keep) console.log(`kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`\n${e.stack ?? e.message}`);
  process.exit(1);
});
