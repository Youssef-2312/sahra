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
import { EXPORTED, type BackupDb, type TableSpec } from "./export";

type Row = Record<string, unknown>;

export interface BackupSource {
  /** Every row of a table as exported, in key order. */
  rows(db: BackupDb, table: string): Promise<Row[]>;
  /** A screenshot's bytes and the SHA-256 checked when it was copied, or null if it is not in the backup. */
  file(id: number): Promise<{ bytes: Uint8Array; sha256: string } | null>;
}

export interface Targets {
  main: SqlDriver;
  ledger: SqlDriver;
  files: SqlDriver | null;
}

export interface LoadReport {
  rows: Record<string, number>;
  files: number;
  file_bytes: number;
  /** Screenshots listed in the backup whose bytes are missing or do not match their SHA-256 / size. */
  file_problems: { id: number; problem: string }[];
}

const BATCH = 50;

export function targetOf(t: Targets, db: BackupDb): SqlDriver | null {
  return db === "main" ? t.main : db === "ledger" ? t.ledger : t.files;
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
  const rep: LoadReport = { rows: {}, files: 0, file_bytes: 0, file_problems: [] };
  for (const spec of EXPORTED) {
    const d = targetOf(t, spec.db);
    if (!d) continue;
    const have = (await d.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${raw(spec.table)}`)).results[0]?.n ?? 0;
    if (Number(have) > 0) throw new Error(`${spec.db}.${spec.table} is not empty: restore only into a fresh database`);
    const cols = await columnsOf(d, spec.table);
    const rows = await src.rows(spec.db, spec.table);
    for (const r of rows) {
      for (const k of Object.keys(r)) if (!cols.has(k)) throw new Error(`${spec.db}.${spec.table}.${k} is in the backup but not in the database: apply the same migrations first`);
    }
    if (spec.db === "files") {
      await loadFiles(d, spec, rows, src, rep);
    } else {
      for (let i = 0; i < rows.length; i += BATCH) await d.batch(rows.slice(i, i + BATCH).map((r) => insert(spec.table, r)));
    }
    rep.rows[`${spec.db}.${spec.table}`] = rows.length;
    log(`${spec.db}.${spec.table}: ${rows.length} row(s)`);
  }
  return rep;
}

async function loadFiles(d: SqlDriver, spec: TableSpec, rows: Row[], src: BackupSource, rep: LoadReport) {
  for (const r of rows) {
    const id = Number(r.id);
    const f = await src.file(id);
    if (!f) { rep.file_problems.push({ id, problem: "bytes missing from the backup" }); continue; }
    const got = await sha256hexBytes(f.bytes);
    if (got !== f.sha256) { rep.file_problems.push({ id, problem: "bytes do not match the recorded SHA-256" }); continue; }
    if (f.bytes.length !== Number(r.size)) { rep.file_problems.push({ id, problem: "size differs from the list" }); continue; }
    // One file per statement; the bytes are a bound BLOB parameter.
    await d.batch([insert(spec.table, { ...r, bytes: f.bytes })]);
    rep.files++;
    rep.file_bytes += f.bytes.length;
  }
}

function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}

export interface CompareReport {
  ok: boolean;
  tables: Record<string, { backup: number; restored: number; different: number }>;
  /** Screenshots whose restored bytes hash differently from the backup's record. */
  blob_mismatches: number[];
  blobs_checked: number;
}

/** Reads everything back from the restored databases: same rows, same values, and every screenshot's bytes hash to the recorded SHA-256. */
export async function compareRestore(t: Targets, src: BackupSource): Promise<CompareReport> {
  const out: CompareReport = { ok: true, tables: {}, blob_mismatches: [], blobs_checked: 0 };
  for (const spec of EXPORTED) {
    const d = targetOf(t, spec.db);
    if (!d) continue;
    const want = await src.rows(spec.db, spec.table);
    const cols = spec.columns ? spec.columns.join(", ") : "*";
    const got = (await d.all<Row>(sql`SELECT ${raw(cols)} FROM ${raw(spec.table)} ORDER BY ${raw(spec.key.join(", "))}`)).results;
    const byKey = new Map(got.map((r) => [canon(spec.key.map((k) => r[k])), canon(r)]));
    let different = Math.abs(got.length - want.length);
    for (const r of want) if (byKey.get(canon(spec.key.map((k) => r[k]))) !== canon(r)) different++;
    out.tables[`${spec.db}.${spec.table}`] = { backup: want.length, restored: got.length, different };
    if (different) out.ok = false;
    if (spec.db === "files") {
      for (const r of got) {
        const f = await src.file(Number(r.id));
        const b = (await d.all<{ bytes: unknown }>(sql`SELECT bytes FROM files WHERE id = ${r.id}`)).results[0];
        out.blobs_checked++;
        if (!f || !b || (await sha256hexBytes(toBytes(b.bytes))) !== f.sha256) out.blob_mismatches.push(Number(r.id));
      }
      if (out.blob_mismatches.length) out.ok = false;
    }
  }
  return out;
}
