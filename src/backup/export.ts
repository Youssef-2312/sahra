// What the backup export contains, and the read-only queries behind it
// (src/routes/backup.ts). Every table of every database is either exported here
// or listed in EXCLUDED with the reason; a test fails when a migration adds a
// table that is in neither list.
//
// Order: main database first, then the screenshot list, then the ledger. The
// pages are ordinary reads spread over minutes, not a snapshot; exporting the
// ledger last means it is never older than the main tables it covers, so a
// restore is "load the tables, then replay the change log" (src/recovery), the
// same rule as a controlled recovery: the newest rev per entity wins.

import type { SqlDriver } from "../db/driver";
import { sql, raw, join, type Sql } from "../db/sql";
import { budgetOk } from "../limits";

export type BackupDb = "main" | "ledger" | "files";

export interface TableSpec {
  db: BackupDb;
  table: string;
  /** Primary key columns, in index order: pages are `key > cursor ORDER BY key` (never OFFSET). */
  key: readonly string[];
  /** Integer key columns (the cursor carries numbers for these). */
  intKey?: readonly string[];
  /** Explicit column list; default every column (columns added later are exported too). */
  columns?: readonly string[];
}

/** In restore order (parents before children, foreign keys). */
export const EXPORTED: readonly TableSpec[] = [
  { db: "main", table: "platform_admins", key: ["id"] },
  { db: "main", table: "organisers", key: ["id"] },
  { db: "main", table: "organiser_invites", key: ["id"] },
  { db: "main", table: "parties", key: ["id"] },
  { db: "main", table: "staff", key: ["id"] },
  { db: "main", table: "invites", key: ["id"] },
  { db: "main", table: "tickets", key: ["id"] },
  { db: "main", table: "scans", key: ["scan_id"] },
  { db: "main", table: "audit", key: ["id"], intKey: ["id"] },
  { db: "main", table: "email_quota", key: ["provider", "hour"], intKey: ["hour"] },
  // The screenshot list without the bytes; each file's bytes come from /api/backup/file/:id.
  { db: "files", table: "files", key: ["id"], intKey: ["id"], columns: ["id", "party_id", "ticket_id", "content_type", "size", "created_at"] },
  { db: "ledger", table: "party_control", key: ["party_id"] },
  { db: "ledger", table: "intents", key: ["op_id", "entity", "entity_id"] },
  { db: "ledger", table: "change_log", key: ["event_id"] },
];

/** Tables deliberately left out of the backup. */
export const EXCLUDED: readonly { db: BackupDb; table: string; reason: string }[] = [
  { db: "main", table: "sessions", reason: "sign-in sessions (hash of each session token): short-lived, and every restore ends all sessions anyway" },
  { db: "main", table: "platform_sessions", reason: "site owner / organiser sessions: same as sessions" },
  { db: "main", table: "health_checks", reason: "health check state (workstream F): recomputed by the next check run" },
  { db: "main", table: "health_state", reason: "health cursors and the last backup time: rebuilt by the next runs" },
  { db: "main", table: "health_discord", reason: "pending Discord copies of health alerts: the next check run raises any alert that still applies" },
  { db: "main", table: "party_usage", reason: "per-party daily counters: losing them only resets that day's count" },
  { db: "main", table: "outbox", reason: "email bodies carry guests' signed ticket links (anyone holding one sees the QR); a restore from Drive sends nothing again, guests use 'resend my ticket link'" },
  { db: "main", table: "d1_migrations", reason: "recreated by applying migrations to the fresh database; the names are in the manifest" },
  { db: "ledger", table: "d1_migrations", reason: "same" },
  { db: "files", table: "d1_migrations", reason: "same" },
  { db: "files", table: "file_tombstones", reason: "which screenshots the retention purge emptied (src/storage/): a restore brings their bytes back from Drive, and the next daily purge empties them again" },
];

/** D1's and SQLite's own tables, never ours. */
export const INTERNAL_TABLE = /^(_cf_|sqlite_)/;

/**
 * Nightly: everything. Hourly: what the recovery replay needs and what cannot be
 * rebuilt, i.e. the ledger (change log, intents, control objects) and the
 * screenshot list (the script then copies only screenshots it does not have).
 * A restore from Drive = the newest nightly's main tables + the newest hourly's
 * ledger and screenshots, then replay (newest rev per entity wins).
 */
export type BackupKind = "nightly" | "hourly";
export function tablesFor(kind: BackupKind): readonly TableSpec[] {
  return kind === "hourly" ? EXPORTED.filter((t) => t.db !== "main") : EXPORTED;
}

export function specOf(db: string, table: string): TableSpec | null {
  return EXPORTED.find((t) => t.db === db && t.table === table) ?? null;
}

export const PAGE_DEFAULT = 200;
export const PAGE_MAX = 500;

type Row = Record<string, unknown>;
type KeyValue = string | number;

/** Cursor = base64url(JSON array of the last row's key values). Only characters the signature allows. */
export function encodeCursor(values: KeyValue[]): string {
  const s = JSON.stringify(values);
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(spec: TableSpec, cursor: string): KeyValue[] | null {
  if (!/^[A-Za-z0-9_-]{1,2000}$/.test(cursor)) return null;
  try {
    const bin = atob(cursor.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (cursor.length % 4)) % 4));
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as unknown;
    if (!Array.isArray(v) || v.length !== spec.key.length) return null;
    for (const [i, k] of spec.key.entries()) {
      const isInt = spec.intKey?.includes(k);
      if (isInt ? !Number.isSafeInteger(v[i]) : typeof v[i] !== "string") return null;
    }
    return v as KeyValue[];
  } catch {
    return null;
  }
}

export interface Page {
  rows: Row[];
  /** Cursor for the next page, or null when this was the last one. */
  next: string | null;
  rows_read: number;
}

/** One page of a table, ordered by its primary key. Rows read is about `limit` (an index range, no scan). */
export async function readPage(d: SqlDriver, spec: TableSpec, after: KeyValue[] | null, limit: number): Promise<Page> {
  const cols = raw(spec.columns ? spec.columns.join(", ") : "*");
  const keyList = spec.key.join(", ");
  let where: Sql = sql``;
  if (after) {
    const vals = join(after.map((v) => sql`${v}`), ", ");
    where = spec.key.length === 1 ? sql`WHERE ${raw(spec.key[0]!)} > ${after[0]}` : sql`WHERE (${raw(keyList)}) > (${vals})`;
  }
  const r = await d.all<Row>(sql`SELECT ${cols} FROM ${raw(spec.table)} ${where} ORDER BY ${raw(keyList)} LIMIT ${limit}`);
  const last = r.results.at(-1);
  const next = r.results.length === limit && last ? encodeCursor(spec.key.map((k) => last[k] as KeyValue)) : null;
  return { rows: r.results, next, rows_read: r.meta.rows_read };
}

/**
 * D1's measured database size in bytes: every D1 result carries meta.size_after.
 * (PRAGMA page_count is not allowed on D1: SQLITE_AUTH.) Read from the binding
 * itself, because the SqlDriver keeps only the row counts.
 */
export async function measuredSize(d1: D1Database | undefined): Promise<number | null> {
  if (!d1) return null;
  const r = await d1.prepare("PRAGMA page_size").all();
  const v = (r.meta as { size_after?: unknown } | undefined)?.size_after;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Rows read here are counted by the caller (driver.usage). */
export interface DbInfo {
  size_bytes: number | null;
  page_size: number | null;
  migrations: string[];
  tables: { name: string; key: readonly string[]; rows?: number }[];
  excluded: { name: string; reason: string }[];
  /** Tables in the database that are neither exported nor excluded (should stay empty). */
  unknown: string[];
}

/**
 * Size, migrations and table list of one database, and with `counts` the rows
 * of every exported table (COUNT(*) reads every row: about as many rows read as
 * the backup itself, so the Apps Script asks for counts only on nightly runs).
 */
export async function dbInfo(d: SqlDriver, db: BackupDb, counts: boolean, size: Promise<number | null>): Promise<DbInfo> {
  const specs = EXPORTED.filter((t) => t.db === db);
  // page_count is not allowed on D1 (SQLITE_AUTH); D1's own measured size comes with every result.
  const ps = await d.all<{ page_size: number }>(sql`PRAGMA page_size`);
  const tables = await d.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`);
  const migrations = tables.results.some((t) => t.name === "d1_migrations")
    ? (await d.all<{ name: string }>(sql`SELECT name FROM d1_migrations ORDER BY id`)).results.map((m) => m.name)
    : [];
  const out: DbInfo = {
    size_bytes: await size,
    page_size: ps.results[0]?.page_size ?? null,
    migrations,
    tables: specs.map((s) => ({ name: s.table, key: s.key })),
    excluded: EXCLUDED.filter((e) => e.db === db).map((e) => ({ name: e.table, reason: e.reason })),
    unknown: tables.results.map((t) => t.name).filter((n) => !INTERNAL_TABLE.test(n) && !specOf(db, n) && !EXCLUDED.some((e) => e.db === db && e.table === n)),
  };
  if (counts && specs.length) {
    const q = specs.map((s) => `(SELECT COUNT(*) FROM ${s.table}) AS ${s.table}`).join(", ");
    const r = await d.all<Record<string, number>>(sql`SELECT ${raw(q)}`);
    const row = r.results[0] ?? {};
    for (const t of out.tables) t.rows = Number(row[t.name] ?? 0);
  }
  return out;
}

// ------------------------------------------------------------------ schedule

export type Frequency = "hourly" | "nightly";

const HOUR = 3600_000;
/** A party night: from 12 hours before the start until 6 hours after the end (or 18 hours after the start without an end). */
export const NIGHT_BEFORE_MS = 12 * HOUR;
export const NIGHT_AFTER_MS = 6 * HOUR;
/** "Selling": a party that is not switched off and not over, and some change in the last 24 hours. */
export const RECENT_MS = 24 * HOUR;

/**
 * Hourly while any party is selling tickets or on a party night, nightly
 * otherwise (brief section 9). Reads the parties table (small) and one audit row.
 * "Selling" is approximated without reading tickets: the newest audit row (every
 * sign-up, approval and change writes one) is under 24 hours old and some party
 * is neither switched off nor over. Also reads health_state (one row) for the
 * daily budget.
 */
export async function schedule(d: SqlDriver, now: number): Promise<{ frequency: Frequency; reasons: string[]; budget_ok: boolean }> {
  const parties = (await d.all<{ id: string; admission_state: string; starts_at: number | null; ends_at: number | null; disabled_at: number | null }>(
    sql`SELECT id, admission_state, starts_at, ends_at, disabled_at FROM parties`)).results;
  const last = (await d.all<{ at: number }>(sql`SELECT at FROM audit ORDER BY id DESC LIMIT 1`)).results[0]?.at ?? null;
  const reasons: string[] = [];
  const live = parties.filter((p) => p.disabled_at === null);
  for (const p of live) {
    const end = p.ends_at ?? (p.starts_at === null ? null : p.starts_at + 12 * HOUR);
    if (p.admission_state === "open") reasons.push(`admission open: ${p.id}`);
    else if (p.starts_at !== null && now >= p.starts_at - NIGHT_BEFORE_MS && end !== null && now <= end + NIGHT_AFTER_MS) reasons.push(`party night: ${p.id}`);
  }
  const notOver = live.some((p) => {
    const end = p.ends_at ?? p.starts_at;
    return end === null || end > now;
  });
  if (notOver && last !== null && now - last < RECENT_MS) reasons.push("selling: changes in the last 24 hours");
  // Workstream F's daily budget (src/limits): past about half of the day's rows
  // written, non-essential work stops. Hourly backups are skipped then; the
  // nightly one never is.
  const budget = (await d.all<{ ok: number }>(sql`SELECT ${budgetOk(now)} AS ok`)).results[0];
  return { frequency: reasons.length ? "hourly" : "nightly", reasons: reasons.slice(0, 20), budget_ok: Number(budget?.ok ?? 0) === 1 };
}
