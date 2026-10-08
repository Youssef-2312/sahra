// Payment screenshots, stored as BLOBs in a separate D1 database (binding FILES,
// later sahra-files-N). Only this module knows how files are stored; callers keep
// the returned key (e.g. "1:123456") on the ticket. Writes are parameterized (the
// bytes are a bound BLOB, never base64 text). Reads require the party and ticket
// the file was stored for; files are served only through an authenticated
// endpoint (src/routes/tickets.ts), never from a public URL.

import type { SqlDriver } from "../db/driver";
import { sql } from "../db/sql";

/** Server-enforced maximum (D1 rows are limited to 2 MB). The browser compresses to about 200 KB. */
export const MAX_FILE_BYTES = 1_500_000;

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

// Only one files database exists so far; the key names it so more can be added.
const SHARD = 1;

export class StorageConflictError extends Error {}

export class FileStore {
  constructor(readonly driver: SqlDriver) {}

  /**
   * Stores a file under `id` (a positive integer below 2^48). Writing the same id
   * again for the same ticket is a no-op (a retried sign-up); an id already used by
   * another ticket throws. Returns the key to keep on the ticket.
   */
  async put(a: { id: number; partyId: string; ticketId: string; type: ImageType; bytes: Uint8Array; now: number }): Promise<string> {
    const rs = await this.driver.batch([
      sql`INSERT INTO files (id, party_id, ticket_id, content_type, size, bytes, created_at)
        VALUES (${a.id}, ${a.partyId}, ${a.ticketId}, ${a.type}, ${a.bytes.length}, ${a.bytes}, ${a.now})
        ON CONFLICT (id) DO NOTHING`,
      sql`SELECT party_id, ticket_id FROM files WHERE id = ${a.id}`,
    ]);
    const row = rs[1]!.results[0] as { party_id: string; ticket_id: string } | undefined;
    if (!row || row.party_id !== a.partyId || row.ticket_id !== a.ticketId) throw new StorageConflictError("file id in use");
    return `${SHARD}:${a.id}`;
  }

  async get(key: string, partyId: string, ticketId: string): Promise<{ type: ImageType; bytes: Uint8Array } | null> {
    const id = parseKey(key);
    if (id === null) return null;
    const r = await this.driver.all<{ content_type: ImageType; bytes: unknown }>(
      sql`SELECT content_type, bytes FROM files WHERE id = ${id} AND party_id = ${partyId} AND ticket_id = ${ticketId}`,
    );
    const row = r.results[0];
    if (!row) return null;
    const v = row.bytes;
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v as number[]);
    return { type: row.content_type, bytes };
  }
}

function parseKey(key: string): number | null {
  const m = /^([1-9])\:([1-9][0-9]{0,15})$/.exec(key);
  if (!m || Number(m[1]) !== SHARD) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) ? id : null;
}
