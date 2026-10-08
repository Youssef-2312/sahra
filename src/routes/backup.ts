// Backup export for the platform owner's Google Apps Script (brief section 9;
// backup/apps-script/). Every endpoint is a GET that reads and never writes, and
// answers only a request signed with BACKUP_KEY (src/backup/auth.ts), checked
// before any database access. Without BACKUP_KEY every endpoint answers 503.
//
//   GET /api/backup/schedule                 hourly or nightly, and why
//   GET /api/backup/manifest[?counts=1]      tables, excluded tables, measured sizes, migrations
//   GET /api/backup/rows/:db/:table?after=&limit=   one page, by primary key
//   GET /api/backup/file/:id                 one screenshot's bytes (+ SHA-256 header)
//
// These are ordinary paged queries, not a D1 export (which would block the
// database): each request reads at most PAGE_MAX rows through the primary key.

import { Hono } from "hono/tiny";
import { json, type AppEnv, type Ctx } from "../context";
import { verifyBackupRequest } from "../backup/auth";
import { dbInfo, decodeCursor, EXPORTED, measuredSize, PAGE_DEFAULT, PAGE_MAX, readPage, schedule, specOf } from "../backup/export";
import { sha256hexBytes, toBytes } from "../backup/restore";
import { D1Driver, type SqlDriver } from "../db/driver";
import { sql } from "../db/sql";

export const backupRoutes = new Hono<AppEnv>();

backupRoutes.use("*", async (c, next) => {
  const v = await verifyBackupRequest(c.env, c.req.raw, c.var.deps.now());
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
    order: EXPORTED.filter((t) => t.db !== "files" || files).map((t) => ({ db: t.db, table: t.table, key: t.key })),
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
