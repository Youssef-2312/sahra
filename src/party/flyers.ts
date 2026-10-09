// Party pictures ("flyers", migrations/0016_party_flyers.sql): up to MAX_FLYERS
// images per party, uploaded by its owner or an admin. Guests see the first on
// the home page card and all of them on the party's page. As everywhere else,
// the rules that decide whether a change happens are inside the statement that
// makes it: the session, the party's limit of pictures, the picture being live.
// The bytes are kept by the storage module (src/storage/); this module keeps the
// row that points to them.

import { audit, sessionValid, type SessionRef } from "../db";
import type { SqlDriver } from "../db/driver";
import { raw, sql, type Sql } from "../db/sql";
import { base32, isBase32, sha256 } from "../lib/crypto";
import type { ImageType } from "../storage";

const MANAGERS = ["owner", "admin"] as const;

/** Live pictures per party (owner decision: more than four). */
export const MAX_FLYERS = 8;

export interface FlyerRow {
  id: string;
  party_id: string;
  file_key: string;
  type: ImageType;
  size: number;
  position: number;
  created_at: number;
  rev: number;
}

export function isFlyerId(v: unknown): v is string {
  return typeof v === "string" && isBase32(v, 16);
}

/**
 * The picture's id and its file's id from the browser's operation id, so a retry
 * after "pending" (or a lost answer) is the same picture and the same file.
 */
export async function flyerIdsFor(partyId: string, op: string): Promise<{ flyerId: string; fileId: number }> {
  const h = await sha256(`sahra-flyer-v1|${partyId}|${op}`);
  let n = 0;
  for (const b of h.subarray(10, 16)) n = n * 256 + b;
  return { flyerId: base32(h.subarray(0, 10), 16), fileId: n + 1 };
}

/** The URL guests load a picture from; `v` changes when the picture does, so browsers may keep it for a year. */
export function flyerUrl(partyId: string, id: string, rev: number): string {
  return `/api/guest/flyers/${encodeURIComponent(partyId)}/${id}?v=${rev}`;
}

/** Parties whose pictures guests may load: switched on and not over (a party without a start time counts as not over). */
export const flyersPublic = (alias: "p", now: number) => {
  const p = raw(alias);
  return sql`${p}.disabled_at IS NULL AND (${p}.starts_at IS NULL OR COALESCE(${p}.ends_at, ${p}.starts_at + 43200000) > ${now})`;
};

export type FlyerChange = { status: "created" | "already" | "deleted" } | { status: "rejected"; reason: "not_allowed" | "too_many_flyers" | "not_found" };

export class FlyerDb {
  constructor(private readonly driver: SqlDriver) {}

  /** The party's live pictures in order (covering index party_flyers_live, plus the table rows for the details). */
  async list(partyId: string): Promise<FlyerRow[]> {
    const r = await this.driver.all<FlyerRow>(sql`SELECT id, party_id, file_key, type, size, position, created_at, rev
      FROM party_flyers WHERE party_id = ${partyId} AND deleted_at IS NULL ORDER BY position, id`);
    return r.results;
  }

  /**
   * Adds a picture whose bytes are already stored under `fileKey`. Refused when
   * the session is not an active owner/admin of the party, or the party already
   * has MAX_FLYERS live pictures (counted in the same statement). The same id
   * again (a retry) changes nothing.
   */
  async add(sess: SessionRef, a: { id: string; fileKey: string; type: ImageType; size: number }, now: number, actor: string, op: string): Promise<FlyerChange> {
    const ok = sessionValid(sess, MANAGERS, now);
    const p = sess.partyId;
    const live = sql`(SELECT COUNT(*) FROM party_flyers WHERE party_id = ${p} AND deleted_at IS NULL)`;
    const rs = await this.driver.batch([
      sql`INSERT INTO party_flyers (id, party_id, file_key, type, size, position, created_at, created_by, last_op, last_action)
        SELECT ${a.id}, ${p}, ${a.fileKey}, ${a.type}, ${a.size},
          (SELECT COALESCE(MAX(position), 0) + 1 FROM party_flyers WHERE party_id = ${p} AND deleted_at IS NULL),
          ${now}, ${actor}, ${op}, 'flyer_added'
        WHERE ${ok} AND ${live} < ${MAX_FLYERS} AND NOT EXISTS (SELECT 1 FROM party_flyers WHERE id = ${a.id})`,
      audit(now, actor, "flyer_added", "flyer", sql`SELECT party_id, id, rev FROM party_flyers WHERE id = ${a.id} AND last_op = ${op}`),
      sql`SELECT ${ok} AS session_ok, ${live} AS live, (SELECT party_id FROM party_flyers WHERE id = ${a.id}) AS existing_party`,
    ]);
    if (rs[0]!.meta.changes === 1) return { status: "created" };
    const d = rs[2]!.results[0] as { session_ok: number; live: number; existing_party: string | null };
    if (!d.session_ok) return { status: "rejected", reason: "not_allowed" };
    if (d.existing_party === p) return { status: "already" };
    if (d.existing_party !== null) return { status: "rejected", reason: "not_allowed" };
    if (d.live >= MAX_FLYERS) return { status: "rejected", reason: "too_many_flyers" };
    return { status: "rejected", reason: "not_allowed" };
  }

  /** Deletes a live picture (soft: the row stays for the change log; the daily purge removes its bytes). */
  async remove(sess: SessionRef, id: string, now: number, actor: string, op: string): Promise<FlyerChange> {
    const ok = sessionValid(sess, MANAGERS, now);
    const p = sess.partyId;
    const rs = await this.driver.batch([
      sql`UPDATE party_flyers SET deleted_at = ${now}, deleted_by = ${actor}, rev = rev + 1, last_op = ${op}, last_action = 'flyer_deleted'
        WHERE id = ${id} AND party_id = ${p} AND deleted_at IS NULL AND ${ok}`,
      audit(now, actor, "flyer_deleted", "flyer", sql`SELECT party_id, id, rev FROM party_flyers WHERE id = ${id} AND last_op = ${op}`),
      sql`SELECT ${ok} AS session_ok, (SELECT deleted_at FROM party_flyers WHERE id = ${id} AND party_id = ${p}) AS deleted_at,
          EXISTS (SELECT 1 FROM party_flyers WHERE id = ${id} AND party_id = ${p}) AS found`,
    ]);
    if (rs[0]!.meta.changes === 1) return { status: "deleted" };
    const d = rs[2]!.results[0] as { session_ok: number; deleted_at: number | null; found: number };
    if (!d.session_ok) return { status: "rejected", reason: "not_allowed" };
    if (!d.found) return { status: "rejected", reason: "not_found" };
    return { status: "already" };
  }

  /** A picture guests may load: live, of a party that is switched on and not over. One indexed read. */
  async publicFile(partyId: string, id: string, now: number): Promise<{ file_key: string; type: ImageType; rev: number } | null> {
    const r = await this.driver.all<{ file_key: string; type: ImageType; rev: number }>(sql`SELECT f.file_key, f.type, f.rev
      FROM party_flyers f JOIN parties p ON p.id = f.party_id
      WHERE f.id = ${id} AND f.party_id = ${partyId} AND f.deleted_at IS NULL AND ${flyersPublic("p", now)}`);
    return r.results[0] ?? null;
  }
}

/** The pictures of each listed party, for the home page query: a JSON array of { id, rev } in order. */
export const flyerListJson = (partyId: Sql) => sql`(SELECT json_group_array(json_object('id', id, 'rev', rev))
  FROM (SELECT id, rev FROM party_flyers WHERE party_id = ${partyId} AND deleted_at IS NULL ORDER BY position, id LIMIT ${MAX_FLYERS}))`;
