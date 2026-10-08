// Backup export for the platform owner's Google Apps Script (brief section 9;
// backup/apps-script/). Every export endpoint is a GET that reads and never
// writes; the one write is POST /done (one row). Each answers only a request
// signed with BACKUP_KEY (src/backup/auth.ts), checked before any database
// access. Without BACKUP_KEY every endpoint answers 503.
//
//   GET /api/backup/schedule                 hourly or nightly, why, and whether the daily budget allows hourly
//   GET /api/backup/manifest[?counts=1|kind=hourly]  tables (all, or ledger + screenshot list), excluded tables, sizes, migrations
//   GET /api/backup/rows/:db/:table?after=&limit=   one page, by primary key
//   GET /api/backup/file/:id                 one screenshot's bytes (+ SHA-256 header)
//   POST /api/backup/done                    the script reports a verified backup (the only write:
//                                            one row, health_state, for workstream F's backup check)
//
// These are ordinary paged queries, not a D1 export (which would block the
// database): each request reads at most PAGE_MAX rows through the primary key.

import { Hono } from "hono/tiny";
import { json, readJson, type AppEnv, type Ctx } from "../context";
import { verifyBackupRequest } from "../backup/auth";
import { dbInfo, decodeCursor, measuredSize, PAGE_DEFAULT, PAGE_MAX, readPage, schedule, specOf, tablesFor } from "../backup/export";
import { sha256hexBytes, toBytes } from "../backup/restore";
import { D1Driver, type SqlDriver } from "../db/driver";
import { sql } from "../db/sql";

export const backupRoutes = new Hono<AppEnv>();

const DONE_MAX_BYTES = 1024;

/** The body, or null as soon as it passes `max` bytes (a missing Content-Length cannot make us read more). */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.length; }
  return out;
}

backupRoutes.use("*", async (c, next) => {
  let body: Uint8Array | undefined;
  if (c.req.method !== "GET") {
    // Small bodies only, read before the signature check (which covers them); nothing touches a database first.
    if (Number(c.req.header("content-length") ?? 0) > DONE_MAX_BYTES) return json(c, 413, { error: "too_large" });
    const read = await readCapped(c.req.raw.clone(), DONE_MAX_BYTES);
    if (!read) return json(c, 413, { error: "too_large" });
    body = read;
  }
  const v = await verifyBackupRequest(c.env, c.req.raw, c.var.deps.now(), body);
  if (!v.ok) return json(c, v.status, { error: v.error });
  await next();
  c.res.headers.set("cache-control", "no-store");
});

function filesDriver(c: Ctx): SqlDriver | null {
  return c.env.FILES ? new D1Driver(c.env.FILES) : null;
}

function driverFor(c: Ctx, db: string, files: SqlDriver | null): SqlDriver | null {
  return db === "main" ? c.var.db.driver : db === "ledger" ? c.var.ledgerDriver : db === "files" ? files : null;
}

/** Rows read per database (the request log line counts only the main database's). */
function logUsage(c: Ctx, files: SqlDriver | null) {
  const m = c.var.db.driver.usage;
  const l = c.var.ledgerDriver.usage;
  console.log(JSON.stringify({
    evt: "backup", route: c.req.routePath, queries: m.queries + l.queries + (files?.usage.queries ?? 0),
    main_rows_read: m.rows_read, ledger_rows_read: l.rows_read, files_rows_read: files?.usage.rows_read ?? 0,
    rows_written: m.rows_written + l.rows_written + (files?.usage.rows_written ?? 0),
  }));
}

backupRoutes.get("/schedule", async (c) => {
  const now = c.var.deps.now();
  const s = await schedule(c.var.db.driver, now);
  logUsage(c, null);
  return json(c, 200, { now, ...s });
});

backupRoutes.get("/manifest", async (c) => {
  const counts = c.req.query("counts") === "1";
  const kind = c.req.query("kind") === "hourly" ? "hourly" : "nightly";
  const now = c.var.deps.now();
  const files = filesDriver(c);
  const [main, ledger, filesInfo, sched] = await Promise.all([
    dbInfo(c.var.db.driver, "main", counts, measuredSize(c.env.DB)),
    dbInfo(c.var.ledgerDriver, "ledger", counts, measuredSize(c.env.LEDGER)),
    files ? dbInfo(files, "files", counts, measuredSize(c.env.FILES)) : Promise.resolve(null),
    schedule(c.var.db.driver, now),
  ]);
  logUsage(c, files);
  return json(c, 200, {
    format: "sahra-backup-1",
    generated_at: now,
    ...sched,
    page_max: PAGE_MAX,
    // Export (and restore) order: the ledger last, so it is never older than the tables it covers.
    kind,
    order: tablesFor(kind).filter((t) => t.db !== "files" || files).map((t) => ({ db: t.db, table: t.table, key: t.key })),
    databases: { main, ledger, files: filesInfo ?? { configured: false } },
  });
});

backupRoutes.get("/rows/:db/:table", async (c) => {
  const spec = specOf(c.req.param("db"), c.req.param("table"));
  const files = spec?.db === "files" ? filesDriver(c) : null;
  const d = spec ? driverFor(c, spec.db, files) : null;
  if (!spec || !d) return json(c, 404, { error: "unknown_table" });
  const limitText = c.req.query("limit");
  const limit = limitText === undefined ? PAGE_DEFAULT : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX) return json(c, 400, { error: "invalid_limit", max: PAGE_MAX });
  const afterText = c.req.query("after");
  const after = afterText === undefined ? null : decodeCursor(spec, afterText);
  if (afterText !== undefined && !after) return json(c, 400, { error: "invalid_cursor" });
  const page = await readPage(d, spec, after, limit);
  logUsage(c, files);
  return json(c, 200, { db: spec.db, table: spec.table, key: spec.key, rows: page.rows, next: page.next });
});

backupRoutes.get("/file/:id", async (c) => {
  const idText = c.req.param("id");
  const files = filesDriver(c);
  if (!files) return json(c, 404, { error: "files_not_configured" });
  if (!/^[1-9][0-9]{0,15}$/.test(idText) || !Number.isSafeInteger(Number(idText))) return json(c, 404, { error: "not_found" });
  const r = await files.all<{ content_type: string; size: number; bytes: unknown }>(
    sql`SELECT content_type, size, bytes FROM files WHERE id = ${Number(idText)}`);
  logUsage(c, files);
  const row = r.results[0];
  if (!row) return json(c, 404, { error: "not_found" });
  const bytes = toBytes(row.bytes);
  // The script checks these against its own hash of what it received, and again after saving to Drive.
  return new Response(bytes, {
    headers: {
      "content-type": "application/octet-stream",
      "x-sahra-sha256": await sha256hexBytes(bytes),
      "x-sahra-size": String(bytes.length),
      "x-sahra-content-type": row.content_type,
      "cache-control": "no-store",
    },
  });
});

const DONE_FOLDER = /^sahra-(backup|ledger)-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z$/;
const DONE_KEYS = ["bytes", "files", "folder", "kind", "rows"];
const countOk = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;

/**
 * The script reports a backup it has fully verified. The time recorded is the
 * backup's start (from the signed folder name), never later than now and at most
 * 3 days ago; it only ever moves forward. One row written (health_state 'main').
 */
backupRoutes.post("/done", async (c) => {
  const b = await readJson(c);
  if (!b || Object.keys(b).sort().join(",") !== DONE_KEYS.join(",")) return json(c, 400, { error: "invalid_request" });
  const m = typeof b.folder === "string" ? DONE_FOLDER.exec(b.folder) : null;
  const kind = b.kind;
  if (!m || (kind !== "hourly" && kind !== "nightly") || (kind === "nightly") !== (m[1] === "backup")) return json(c, 400, { error: "invalid_request" });
  if (!countOk(b.rows, 1e9) || !countOk(b.files, 1e7) || !countOk(b.bytes, 1e13)) return json(c, 400, { error: "invalid_request" });
  const at = Date.UTC(+m[2]!, +m[3]! - 1, +m[4]!, +m[5]!, +m[6]!);
  const d = new Date(at);
  const now = c.var.deps.now();
  if (d.getUTCMonth() !== +m[3]! - 1 || d.getUTCDate() !== +m[4]! || +m[5]! > 23 || +m[6]! > 59) return json(c, 400, { error: "invalid_request" });
  if (at > now + 5 * 60_000 || at < now - 3 * 86_400_000) return json(c, 400, { error: "invalid_time" });
  const note = `${kind} ${b.folder}: ${b.rows} rows, ${b.files} screenshots (${b.bytes} bytes)`;
  const r = await c.var.db.driver.all(sql`UPDATE health_state SET last_backup_at = ${at}, last_backup_note = ${note}
    WHERE id = 'main' AND (last_backup_at IS NULL OR last_backup_at <= ${at})`);
  logUsage(c, null);
  return json(c, 200, { recorded: r.meta.changes === 1, last_backup_at: at });
});
