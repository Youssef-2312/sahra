// Loads a backup (as the Apps Script saved it to Drive) into FRESH, migrated
// databases and checks the result. Shared by the tests (workerd, D1 bindings)
// and scripts/restore-drill.mjs (Node, a fresh local D1). The owner never runs
// this against a live database: a restore from Drive goes into new databases,
// then through the controlled recovery procedure (src/recovery).
//
// Every row is one parameterized INSERT (no SQL text built from values), up to
// 50 per batch. Screenshots are restored file by file, the bytes bound as a BLOB
// parameter: one statement per file, far below D1's 100 KB statement limit
// whatever the file's size (up to 1.5 MB).

import type { SqlDriver } from "../db/driver";
import { sql, raw, join } from "../db/sql";
import { hex } from "../lib/crypto";
import { exportedFor, isFilesDb, selectOf, type BackupDb, type FilesDb, type TableSpec } from "./export";

type Row = Record<string, unknown>;

export interface BackupSource {
  /** Every row of a table as exported, in key order. */
  rows(db: BackupDb, table: string): Promise<Row[]>;
  /** A screenshot's bytes and the SHA-256 checked when it was copied, or null if it is not in the backup. */
  file(db: FilesDb, id: number): Promise<{ bytes: Uint8Array; sha256: string } | null>;
  /** A screenshot whose Drive copy the backup script deleted on purpose (retention), or null. */
  removed?(db: FilesDb, id: number): Promise<{ removed_at: number; reason: string } | null>;
}

export interface Targets {
  main: SqlDriver;
  ledger: SqlDriver;
  /** One fresh database per files database in the backup ("files" = database 1, "files_2", ...). */
  files: Partial<Record<FilesDb, SqlDriver>>;
}

export interface LoadReport {
  rows: Record<string, number>;
  files: number;
  file_bytes: number;
  /** Purged screenshots (retention) whose bytes the backup still had: restored with their bytes. */
  purged_restored: number;
  /** Purged screenshots the backup never had: restored as purged (empty bytes + tombstone), as in the live database. */
  purged_without_bytes: number;
  /** Screenshots listed in the backup whose bytes are missing or do not match their SHA-256 / size. */
  file_problems: { db: FilesDb; id: number; problem: string }[];
}

const BATCH = 50;

export function targetOf(t: Targets, db: BackupDb): SqlDriver | null {
  return db === "main" ? t.main : db === "ledger" ? t.ledger : t.files[db] ?? null;
}

/** The tables to restore into these targets, in order. */
export function specsFor(t: Targets): TableSpec[] {
  return exportedFor((Object.keys(t.files) as FilesDb[]).filter((k) => t.files[k]));
}

function strip(row: Row, spec: TableSpec): Row {
  if (!spec.derived) return row;
  const out = { ...row };
  for (const k of spec.derived) delete out[k];
  return out;
}

export async function sha256hexBytes(b: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
}

async function columnsOf(d: SqlDriver, table: string): Promise<Set<string>> {
  const r = await d.all<{ name: string }>(sql`SELECT name FROM pragma_table_info(${table})`);
  return new Set(r.results.map((c) => c.name));
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected column name ${name}`);
  return name;
}

function insert(table: string, row: Row) {
  const names = Object.keys(row).map(ident);
  return sql`INSERT INTO ${raw(table)} (${raw(names.join(", "))}) VALUES (${join(names.map((n) => sql`${row[n] ?? null}`), ", ")})`;
}

export function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error("not a BLOB");
}

/** Loads every exported table into empty, migrated databases (refuses a database that already has rows). */
export async function loadBackup(t: Targets, src: BackupSource, log: (l: string) => void = () => {}): Promise<LoadReport> {
  const rep: LoadReport = { rows: {}, files: 0, file_bytes: 0, purged_restored: 0, purged_without_bytes: 0, file_problems: [] };
  for (const spec of specsFor(t)) {
    const d = targetOf(t, spec.db);
    if (!d) continue;
    // migrations/0009_health.sql seeds the reserved '_platform' party (needed by the
    // outbox's foreign key); the backup carries its own copy, so it is replaced.
    const seeded = spec.db === "main" && spec.table === "parties" ? sql` WHERE id != '_platform'` : sql``;
    const have = (await d.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${raw(spec.table)}${seeded}`)).results[0]?.n ?? 0;
    if (Number(have) > 0) throw new Error(`${spec.db}.${spec.table} is not empty: restore only into a fresh database`);
    if (spec.db === "main" && spec.table === "parties") await d.batch([sql`DELETE FROM parties WHERE id = '_platform'`]);
    const cols = await columnsOf(d, spec.table);
    const rows = await src.rows(spec.db, spec.table);
    for (const r of rows) {
      for (const k of Object.keys(strip(r, spec))) if (!cols.has(k)) throw new Error(`${spec.db}.${spec.table}.${k} is in the backup but not in the database: apply the same migrations first`);
    }
    if (isFilesDb(spec.db)) {
      await loadFiles(d, spec.db, spec, rows, src, rep);
    } else {
      for (let i = 0; i < rows.length; i += BATCH) await d.batch(rows.slice(i, i + BATCH).map((r) => insert(spec.table, r)));
    }
    rep.rows[`${spec.db}.${spec.table}`] = rows.length;
    log(`${spec.db}.${spec.table}: ${rows.length} row(s)`);
  }
  return rep;
}

async function loadFiles(d: SqlDriver, db: FilesDb, spec: TableSpec, rows: Row[], src: BackupSource, rep: LoadReport) {
  for (const r of rows) {
    const id = Number(r.id);
    const purged = r.purged_at != null;
    let removed: { removed_at: number; reason: string } | null = null;
    const f = await src.file(db, id);
    let problem: string | null = null;
    if (!f) problem = "bytes missing from the backup";
    else if ((await sha256hexBytes(f.bytes)) !== f.sha256) problem = "bytes do not match the recorded SHA-256";
    else if (f.bytes.length !== Number(r.size)) problem = "size differs from the list";
    const row = strip(r, spec);
    if (!problem) {
      // One file per statement; the bytes are a bound BLOB parameter.
      await d.batch([insert("files", { ...row, bytes: f!.bytes })]);
      rep.files++;
      rep.file_bytes += f!.bytes.length;
      if (purged) rep.purged_restored++;
    } else if (!f && (purged || (removed = (await src.removed?.(db, id)) ?? null))) {
      // Purged before any backup copied it, or its copy deleted later by the retention
      // rules (an older backup still lists it): restored as purged, like the live database.
      const at = purged ? r.purged_at : removed!.removed_at, why = purged ? r.purged_reason : removed!.reason;
      await d.batch([
        insert("files", { ...row, bytes: new Uint8Array() }),
        sql`INSERT INTO file_tombstones (id, party_id, ticket_id, deleted_at, reason) VALUES (${id}, ${r.party_id}, ${r.ticket_id}, ${at}, ${why})`,
      ]);
      rep.purged_without_bytes++;
    } else {
      rep.file_problems.push({ db, id, problem });
    }
  }
}

function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}

export interface CompareReport {
  ok: boolean;
  tables: Record<string, { backup: number; restored: number; different: number }>;
  /** Screenshots whose restored bytes hash differently from the backup's record ("<db>:<id>"). */
  blob_mismatches: string[];
  blobs_checked: number;
  /** Restored as purged (tombstone, no bytes), because the backup never had their bytes. */
  purged: number;
}

/** Reads everything back from the restored databases: same rows, same values, and every screenshot's bytes hash to the recorded SHA-256. */
export async function compareRestore(t: Targets, src: BackupSource): Promise<CompareReport> {
  const out: CompareReport = { ok: true, tables: {}, blob_mismatches: [], blobs_checked: 0, purged: 0 };
  for (const spec of specsFor(t)) {
    const d = targetOf(t, spec.db);
    if (!d) continue;
    const want = await src.rows(spec.db, spec.table);
    const sel = selectOf(spec);
    const got = (await d.all<Row>(sql`SELECT ${raw(sel.cols)} FROM ${raw(sel.from)} ORDER BY ${raw(spec.key.map(sel.key).join(", "))}`)).results;
    // Purge marks are compared below: a purged screenshot whose bytes the backup had comes back with its bytes.
    const byKey = new Map(got.map((r) => [canon(spec.key.map((k) => r[k])), canon(strip(r, spec))]));
    let different = Math.abs(got.length - want.length);
    for (const r of want) if (byKey.get(canon(spec.key.map((k) => r[k]))) !== canon(strip(r, spec))) different++;
    out.tables[`${spec.db}.${spec.table}`] = { backup: want.length, restored: got.length, different };
    if (different) out.ok = false;
    if (isFilesDb(spec.db)) {
      for (const r of got) {
        const f = await src.file(spec.db, Number(r.id));
        if (r.purged_at != null && !f) { out.purged++; continue; }
        const b = (await d.all<{ bytes: unknown }>(sql`SELECT bytes FROM files WHERE id = ${r.id}`)).results[0];
        out.blobs_checked++;
        if (r.purged_at != null || !f || !b || (await sha256hexBytes(toBytes(b.bytes))) !== f.sha256) out.blob_mismatches.push(`${spec.db}:${r.id}`);
      }
      if (out.blob_mismatches.length) out.ok = false;
    }
  }
  return out;
}
