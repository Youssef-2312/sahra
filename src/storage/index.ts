// Payment screenshots, stored as BLOBs in separate D1 databases (bindings FILES =
// sahra-files-1, and optionally FILES_2 .. FILES_4 = sahra-files-2 .. 4). Only this
// module knows how files are stored; callers keep the returned key on the ticket:
// "f<N>:<id>" names database N. Older keys ("1:<id>", or a bare id) mean FILES.
// Writes are parameterized (the bytes are a bound BLOB, never base64 text). Reads
// require the party and ticket the file was stored for; files are served only
// through an authenticated endpoint (src/routes/tickets.ts), never from a public URL.
//
// Capacity (D1 Free: 500 MB per database): a new upload goes to the first
// configured database whose size (D1's own meta.size_after) is under 70%; when
// every configured database is past 70%, uploads answer 503 (fail closed) and the
// health check says so (filesCapacity, src/health).
//
// Retention (purgeOldScreenshots, run by the daily health run): the bytes of a
// screenshot are deleted 30 days after its party ended, or 30 days after its
// ticket was rejected or cancelled; a screenshot no ticket points to (a sign-up
// that then found the party full) after 1 day. A tombstone row stays
// (file_tombstones), so the queue can say why; the nightly Drive backup keeps the
// bytes.

import { D1Driver, type SqlDriver } from "../db/driver";
import { inList, join, sql, type Sql } from "../db/sql";

/**
 * Server-enforced maximum. The browser compresses to about 250 KB (longest side
 * about 1600 px, JPEG); this leaves room for a slightly larger phone image.
 */
export const MAX_FILE_BYTES = 600_000;

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

/** The image type from the file's first bytes (never from what the browser claims), or null. */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((x, i) => b[i] === x)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

// ------------------------------------------------------------- databases

/** Binding names in fill order; database N is BINDINGS[N - 1]. */
export const FILE_BINDINGS = ["FILES", "FILES_2", "FILES_3", "FILES_4"] as const;
export type FilesEnv = Partial<Record<(typeof FILE_BINDINGS)[number], D1Database>>;

export const FILES_DB_BYTES = 500 * 1000 * 1000;
export const FILES_FULL_AT = 0.7;

export interface FilesDb {
  shard: number;
  binding: string;
  bytes: number | null;
  /** Past 70% of 500 MB (or its size could not be read): no new uploads here. */
  full: boolean;
}

export interface FilesCapacity {
  databases: FilesDb[];
  /** Database new uploads go to; null when none is configured or all are full. */
  writable: number | null;
  state: "ok" | "not_configured" | "full";
}

export function filesBinding(env: FilesEnv, shard: number): D1Database | undefined {
  return env[FILE_BINDINGS[shard - 1]!];
}

async function sizeOf(d: D1Database): Promise<number | null> {
  // No rows read, nothing written; PRAGMA page_count is not allowed on D1.
  const r = await d.prepare("SELECT 1").all();
  const s = Number((r.meta as { size_after?: number }).size_after);
  return Number.isFinite(s) ? s : null;
}

/** Every configured files database with its size, and where new uploads go. One cheap query per database. */
export async function filesCapacity(env: FilesEnv): Promise<FilesCapacity> {
  const configured = FILE_BINDINGS.map((b, i) => ({ binding: b, shard: i + 1, d: env[b] })).filter((x) => x.d);
  const databases = await Promise.all(configured.map(async (x): Promise<FilesDb> => {
    const bytes = await sizeOf(x.d!);
    return { shard: x.shard, binding: x.binding, bytes, full: bytes == null || bytes >= FILES_DB_BYTES * FILES_FULL_AT };
  }));
  const open = databases.find((d) => !d.full);
  return { databases, writable: open?.shard ?? null, state: !databases.length ? "not_configured" : open ? "ok" : "full" };
}

// The choice of database is cached per isolate for a minute (keyed by the set of
// bindings): one size query per upload would be cheap too, but the answer changes slowly.
let picks = new WeakMap<object, { at: number; bindings: string; cap: FilesCapacity }>();
const PICK_TTL_MS = 60_000;

export async function uploadTarget(env: FilesEnv, now: number): Promise<FilesCapacity> {
  const first = FILE_BINDINGS.map((b) => env[b]).find(Boolean);
  const bindings = FILE_BINDINGS.filter((b) => env[b]).join(",");
  const hit = first ? picks.get(first) : undefined;
  if (hit && hit.bindings === bindings && now >= hit.at && now - hit.at < PICK_TTL_MS) return hit.cap;
  const cap = await filesCapacity(env);
  if (first) picks.set(first, { at: now, bindings, cap });
  return cap;
}

/** Tests only: forget the cached choices. */
export function resetUploadTarget() {
  picks = new WeakMap();
}

export function parseFileKey(key: string): { shard: number; id: number } | null {
  const m = /^(?:f([1-4]):|1:)?([1-9][0-9]{0,15})$/.exec(key);
  if (!m) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) ? { shard: m[1] ? Number(m[1]) : 1, id } : null;
}

export class StorageConflictError extends Error {}

export type StoredFile = { type: ImageType; bytes: Uint8Array } | { deleted: string };

export class FileStore {
  constructor(readonly driver: SqlDriver, readonly shard = 1) {}

  static for(env: FilesEnv, shard: number): FileStore | null {
    const d = filesBinding(env, shard);
    return d ? new FileStore(new D1Driver(d), shard) : null;
  }

  /**
   * Stores a file under `id` (a positive integer below 2^48). Writing the same id
   * again for the same ticket is a no-op (a retried sign-up), or brings back a file
   * an orphan purge removed meanwhile; an id already used by another ticket throws.
   * Returns the key to keep on the ticket.
   */
  async put(a: { id: number; partyId: string; ticketId: string; type: ImageType; bytes: Uint8Array; now: number }): Promise<string> {
    const mine = sql`party_id = ${a.partyId} AND ticket_id = ${a.ticketId}`;
    const rs = await this.driver.batch([
      sql`INSERT INTO files (id, party_id, ticket_id, content_type, size, bytes, created_at)
        VALUES (${a.id}, ${a.partyId}, ${a.ticketId}, ${a.type}, ${a.bytes.length}, ${a.bytes}, ${a.now})
        ON CONFLICT (id) DO UPDATE SET content_type = excluded.content_type, size = excluded.size, bytes = excluded.bytes,
          created_at = excluded.created_at
        WHERE ${mine} AND EXISTS (SELECT 1 FROM file_tombstones d WHERE d.id = files.id)`,
      sql`DELETE FROM file_tombstones WHERE id = ${a.id} AND EXISTS (SELECT 1 FROM files WHERE id = ${a.id} AND ${mine})`,
      sql`SELECT party_id, ticket_id FROM files WHERE id = ${a.id}`,
    ]);
    const row = rs[2]!.results[0] as { party_id: string; ticket_id: string } | undefined;
    if (!row || row.party_id !== a.partyId || row.ticket_id !== a.ticketId) throw new StorageConflictError("file id in use");
    return `f${this.shard}:${a.id}`;
  }

  async get(id: number, partyId: string, ticketId: string): Promise<StoredFile | null> {
    const r = await this.driver.all<{ content_type: ImageType; bytes: unknown; deleted: string | null }>(
      sql`SELECT f.content_type, CASE WHEN d.id IS NULL THEN f.bytes END AS bytes, d.reason AS deleted
        FROM files f LEFT JOIN file_tombstones d ON d.id = f.id
        WHERE f.id = ${id} AND f.party_id = ${partyId} AND f.ticket_id = ${ticketId}`,
    );
    const row = r.results[0];
    if (!row) return null;
    if (row.deleted) return { deleted: row.deleted };
    const v = row.bytes;
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v as number[]);
    return { type: row.content_type, bytes };
  }
}

/** The screenshot of a ticket by its stored key (routes by the key's database). */
export async function getScreenshot(env: FilesEnv, key: string, partyId: string, ticketId: string): Promise<StoredFile | null | "not_configured"> {
  const k = parseFileKey(key);
  if (!k) return null;
  const store = FileStore.for(env, k.shard);
  if (!store) return "not_configured";
  return store.get(k.id, partyId, ticketId);
}

// ------------------------------------------------------------- retention

const DAY = 86_400_000;
export const RETENTION = {
  /** After the party ended, and after a rejection or cancellation. */
  keepDays: 30,
  /** A screenshot no ticket points to (the sign-up failed after the upload). */
  orphanDays: 1,
  /** Screenshots deleted per database per run. */
  perRun: 200,
  /** Bound values per statement (D1 allows 100). */
  chunk: 90,
};

export const DELETED_REASON = {
  party_ended: "screenshot deleted 30 days after the party (kept in the Drive backup)",
  rejected: "screenshot deleted 30 days after the request was rejected (kept in the Drive backup)",
  cancelled: "screenshot deleted 30 days after the ticket was cancelled (kept in the Drive backup)",
  orphan: "screenshot of a request that was not stored",
} as const;

export interface PurgeReport {
  databases: { shard: number; live: number; deleted: Record<string, number>; more: boolean }[];
  main_rows_read: number;
  files_rows_read: number;
  files_rows_written: number;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Deletes the bytes of screenshots past their retention, at most RETENTION.perRun
 * per database per run (the next run continues), keeping a tombstone. Per database:
 * one read of the live files (covering index, no BLOBs read), one read of their
 * tickets in the main database (by party, tickets_party_status index), one write
 * batch. The decision uses the main database as read just before; screenshots are
 * only ever removed after their 30 days (or 1 day for a file no ticket points to).
 */
export async function purgeOldScreenshots(env: FilesEnv, main: SqlDriver, now: number): Promise<PurgeReport> {
  const report: PurgeReport = { databases: [], main_rows_read: 0, files_rows_read: 0, files_rows_written: 0 };
  const mainRead0 = main.usage.rows_read;
  for (let shard = 1; shard <= FILE_BINDINGS.length; shard++) {
    const store = FileStore.for(env, shard);
    if (!store) continue;
    const fd = store.driver;
    const live = (await fd.all<{ id: number; party_id: string; ticket_id: string; created_at: number }>(
      sql`SELECT f.id, f.party_id, f.ticket_id, f.created_at FROM files f INDEXED BY files_meta
        WHERE NOT EXISTS (SELECT 1 FROM file_tombstones d WHERE d.id = f.id)`)).results;
    const tickets = new Map<string, { party_id: string; screenshot_key: string | null; status: string; rejected_at: number | null;
      cancelled_at: number | null; ends_at: number | null }>();
    const parties = [...new Set(live.map((f) => f.party_id))];
    if (parties.length) {
      const rs = await main.batch(chunks(parties, RETENTION.chunk).map((ps) => sql`SELECT t.id, t.party_id, t.screenshot_key, t.status,
          t.rejected_at, t.cancelled_at, p.ends_at
        FROM tickets t JOIN parties p ON p.id = t.party_id
        WHERE t.party_id IN (${inList(ps)}) AND t.screenshot_key IS NOT NULL`));
      for (const r of rs) for (const t of r.results as Record<string, unknown>[]) tickets.set(String(t.id), t as never);
    }
    const old = now - RETENTION.keepDays * DAY;
    const due: { id: number; party_id: string; ticket_id: string; reason: keyof typeof DELETED_REASON }[] = [];
    for (const f of live) {
      const t = tickets.get(f.ticket_id);
      const k = t?.screenshot_key ? parseFileKey(t.screenshot_key) : null;
      let reason: keyof typeof DELETED_REASON | null = null;
      if (!t || t.party_id !== f.party_id || !k || k.shard !== shard || k.id !== f.id) {
        if (f.created_at < now - RETENTION.orphanDays * DAY) reason = "orphan";
      } else if (t.ends_at != null && t.ends_at < old) {
        reason = "party_ended";
      } else if (t.status === "rejected" && t.rejected_at != null && t.rejected_at < old) {
        reason = "rejected";
      } else if (t.status === "cancelled" && t.cancelled_at != null && t.cancelled_at < old) {
        reason = "cancelled";
      }
      if (reason) due.push({ id: f.id, party_id: f.party_id, ticket_id: f.ticket_id, reason });
    }
    const todo = due.slice(0, RETENTION.perRun);
    const deleted: Record<string, number> = {};
    if (todo.length) {
      const writes: Sql[] = [];
      for (const reason of Object.keys(DELETED_REASON) as (keyof typeof DELETED_REASON)[]) {
        for (const part of chunks(todo.filter((d) => d.reason === reason).map((d) => d.id), RETENTION.chunk)) {
          const ids = join(part.map((id) => sql`${id}`), ", ");
          writes.push(sql`INSERT INTO file_tombstones (id, party_id, ticket_id, deleted_at, reason)
            SELECT id, party_id, ticket_id, ${now}, ${DELETED_REASON[reason]} FROM files WHERE id IN (${ids})
            ON CONFLICT (id) DO NOTHING`);
          writes.push(sql`UPDATE files SET bytes = x'' WHERE id IN (${ids})`);
        }
      }
      await fd.batch(writes);
      for (const d of todo) deleted[d.reason] = (deleted[d.reason] ?? 0) + 1;
    }
    report.databases.push({ shard, live: live.length, deleted, more: due.length > todo.length });
    report.files_rows_read += fd.usage.rows_read;
    report.files_rows_written += fd.usage.rows_written;
  }
  report.main_rows_read = main.usage.rows_read - mainRead0;
  return report;
}
