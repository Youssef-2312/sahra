// Ticket types (migrations/0014_types_and_registration.sql): a party's own kinds
// of ticket ("Early", "Regular", "VIP", a staff-only "Guest list"), each with a
// price, optional places, an optional sales window and an optional "entry from"
// time at the door. As everywhere else, the rules that decide whether a change
// happens are inside the statement that makes it: the session, the party's limit
// of types, the sales window order, and places versus places held.
//
// "Early" is not special in the code: the owner decides what it means by setting
// its sales window (early bird) and/or its entry time (early entry).

import { audit, sessionValid, type SessionRef } from "../db";
import type { SqlDriver } from "../db/driver";
import { join, raw, sql, type Sql } from "../db/sql";
import { base32, isBase32, sha256 } from "../lib/crypto";
import { MAX_T, MIN_T, text } from "../party/input";
import { isTimeZone, zonedToUtc } from "../party/time";

const MANAGERS = ["owner", "admin"] as const;

/** Active (not archived) types per party. Archived ones stay for the tickets that have them. */
export const MAX_ACTIVE_TYPES = 20;
export const MAX_PRICE = 1_000_000;
export const MAX_TYPE_QUANTITY = 100_000;

/** People on pending + approved tickets of a type (covering index tickets_type_status). */
export const typeHeld = (typeId: Sql) =>
  sql`(SELECT COALESCE(SUM(h.people), 0) FROM tickets h WHERE h.type_id = ${typeId} AND h.status IN ('pending', 'approved'))`;
export const typeApproved = (typeId: Sql) =>
  sql`(SELECT COALESCE(SUM(h.people), 0) FROM tickets h WHERE h.type_id = ${typeId} AND h.status = 'approved')`;

/** The type is on sale to guests at `now`: active, public, inside its sales window. `tt` is the type's alias. */
export const onSale = (now: number) => sql`tt.archived_at IS NULL AND tt.staff_only = 0
  AND (tt.sales_opens_at IS NULL OR tt.sales_opens_at <= ${now}) AND (tt.sales_closes_at IS NULL OR tt.sales_closes_at > ${now})`;

/** True when the party has public types (then every guest request must name one). */
export const hasPublicTypes = (partyId: Sql) =>
  sql`EXISTS (SELECT 1 FROM ticket_types pt WHERE pt.party_id = ${partyId} AND pt.archived_at IS NULL AND pt.staff_only = 0)`;

/**
 * People one ticket admits (migrations/0021): the type's own min_people / max_people
 * when it sets them, otherwise 1 up to the party's max_people_per_ticket. `p` is
 * the party's alias in the statement.
 */
export function peopleOk(typeId: string | null, people: number): Sql {
  if (typeId === null) return sql`(${people} >= 1 AND ${people} <= p.max_people_per_ticket)`;
  const col = (c: string) => sql`(SELECT tt.${raw(c)} FROM ticket_types tt WHERE tt.id = ${typeId} AND tt.party_id = p.id)`;
  return sql`(${people} >= COALESCE(${col("min_people")}, 1) AND ${people} <= COALESCE(${col("max_people")}, p.max_people_per_ticket))`;
}
export const MAX_TYPE_PEOPLE = 50;

export const TYPE_FIELDS = [
  "name", "description", "price", "quantity", "sales_opens_at", "sales_closes_at", "entry_from", "staff_only",
  "payment_instructions", "sort", "min_people", "max_people",
] as const;
type TypeField = (typeof TYPE_FIELDS)[number];
const TIMES = ["sales_opens_at", "sales_closes_at", "entry_from"] as const;
export type TypeValues = Partial<Record<TypeField, string | number | null>>;

export interface TicketTypeRow {
  id: string;
  party_id: string;
  name: string;
  description: string | null;
  price: number;
  quantity: number | null;
  sales_opens_at: number | null;
  sales_closes_at: number | null;
  entry_from: number | null;
  staff_only: number;
  payment_instructions: string | null;
  sort: number;
  min_people: number | null;
  max_people: number | null;
  archived_at: number | null;
  rev: number;
}

export function isTypeId(v: unknown): v is string {
  return typeof v === "string" && isBase32(v, 16);
}

/** The type's id from the browser's operation id, so a retry after "pending" is the same type. */
export async function typeIdFor(partyId: string, op: string): Promise<string> {
  return base32((await sha256(`sahra-type-v1|${partyId}|${op}`)).subarray(0, 10), 16);
}

/**
 * A create or edit body. Times are `<field>` (UTC ms) or `<field>_local`
 * ("YYYY-MM-DDTHH:MM" in the party's time zone, given by the caller). `archived`
 * (true/false) archives or restores a type on edit.
 */
export function parseType(b: Record<string, unknown>, timeZone: string | null, creating: boolean):
  { ok: true; values: TypeValues; archived: boolean | null } | { ok: false; error: string } {
  const allowed = new Set<string>([...TYPE_FIELDS, ...TIMES.map((f) => `${f}_local`), "op", "archived"]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) return { ok: false, error: `unknown_field:${k}` };
  const bad = (f: string) => ({ ok: false as const, error: `invalid_field:${f}` });
  const v: TypeValues = {};
  if ("name" in b || creating) {
    const s = text(b.name, 60, false);
    if (!s) return bad("name");
    v.name = s;
  }
  if ("description" in b) {
    const s = text(b.description, 500, true);
    if (s === undefined) return bad("description");
    v.description = s;
  }
  if ("payment_instructions" in b) {
    const s = text(b.payment_instructions, 1000, true);
    if (s === undefined) return bad("payment_instructions");
    v.payment_instructions = s;
  }
  if ("price" in b) {
    const n = b.price;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_PRICE) return bad("price");
    v.price = n;
  }
  if ("quantity" in b) {
    const n = b.quantity;
    if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_TYPE_QUANTITY)) return bad("quantity");
    v.quantity = n as number | null;
  }
  for (const f of ["min_people", "max_people"] as const) {
    if (!(f in b)) continue;
    const n = b[f];
    if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_TYPE_PEOPLE)) return bad(f);
    v[f] = n as number | null;
  }
  if ("sort" in b) {
    const n = b.sort;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1000) return bad("sort");
    v.sort = n;
  }
  if ("staff_only" in b) {
    if (typeof b.staff_only !== "boolean") return bad("staff_only");
    v.staff_only = b.staff_only ? 1 : 0;
  }
  for (const f of TIMES) {
    const local = `${f}_local`;
    if (f in b && local in b) return bad(f);
    if (f in b) {
      const t = b[f];
      if (t !== null && (typeof t !== "number" || !Number.isInteger(t) || t < MIN_T || t > MAX_T)) return bad(f);
      v[f] = t as number | null;
    } else if (local in b) {
      if (b[local] === null) {
        v[f] = null;
        continue;
      }
      if (!isTimeZone(timeZone)) return { ok: false, error: "party_time_zone_not_set" };
      const t = zonedToUtc(b[local], timeZone);
      if (t === null || t < MIN_T || t > MAX_T) return bad(local);
      v[f] = t;
    }
  }
  if ("archived" in b && typeof b.archived !== "boolean") return bad("archived");
  const archived = typeof b.archived === "boolean" ? b.archived : null;
  if (!creating && Object.keys(v).length === 0 && archived === null) return { ok: false, error: "nothing_to_change" };
  return { ok: true, values: v, archived };
}

export type TypeChange =
  | { status: "created" | "changed" | "already" }
  | { status: "rejected"; reason: "not_allowed" | "not_found" | "too_many_types" | "sales_close_before_open" | "quantity_below_held" | "people_min_above_max"; held?: number };

export class TypeDb {
  constructor(readonly driver: SqlDriver) {}

  /** Owner/admin list: every type (archived too) with places held, approved and admitted. */
  async list(sess: SessionRef, now: number) {
    const r = await this.driver.all<TicketTypeRow & { held: number; approved: number; admitted: number }>(sql`SELECT tt.id, tt.party_id,
        tt.name, tt.description, tt.price, tt.quantity, tt.sales_opens_at, tt.sales_closes_at, tt.entry_from, tt.staff_only,
        tt.payment_instructions, tt.sort, tt.min_people, tt.max_people, tt.archived_at, tt.rev,
        ${typeHeld(sql`tt.id`)} AS held, ${typeApproved(sql`tt.id`)} AS approved,
        (SELECT COALESCE(SUM(u.people), 0) FROM tickets u WHERE u.type_id = tt.id AND u.used_at IS NOT NULL) AS admitted
      FROM ticket_types tt WHERE tt.party_id = ${sess.partyId} AND ${sessionValid(sess, MANAGERS, now)}
      ORDER BY tt.archived_at IS NOT NULL, tt.sort, tt.created_at, tt.id`);
    return r.results;
  }

  /** The public sign-up form's types: active and not staff-only, with places left. */
  async publicList(partyId: string, now: number) {
    const r = await this.driver.all<{
      id: string; name: string; description: string | null; price: number; quantity: number | null; held: number;
      sales_opens_at: number | null; sales_closes_at: number | null; payment_instructions: string | null; on_sale: number;
      min_people: number | null; max_people: number | null;
    }>(sql`SELECT tt.id, tt.name, tt.description, tt.price, tt.quantity, ${typeHeld(sql`tt.id`)} AS held,
        tt.sales_opens_at, tt.sales_closes_at, tt.payment_instructions, (${onSale(now)}) AS on_sale, tt.min_people, tt.max_people
      FROM ticket_types tt WHERE tt.party_id = ${partyId} AND tt.archived_at IS NULL AND tt.staff_only = 0
      ORDER BY tt.sort, tt.created_at, tt.id`);
    return r.results;
  }

  async get(partyId: string, id: string): Promise<TicketTypeRow | null> {
    const r = await this.driver.all<TicketTypeRow>(sql`SELECT * FROM ticket_types WHERE id = ${id} AND party_id = ${partyId}`);
    return r.results[0] ?? null;
  }

  /** New type: only under the party's limit of active types, with its sales window in order. */
  async create(sess: SessionRef, id: string, v: TypeValues, now: number, actor: string, op: string): Promise<TypeChange> {
    const ok = sessionValid(sess, MANAGERS, now);
    const p = sess.partyId;
    const val = (f: TypeField, d: string | number | null) => sql`${f in v ? v[f] ?? null : d}`;
    const windowOk = sql`(${val("sales_opens_at", null)} IS NULL OR ${val("sales_closes_at", null)} IS NULL
      OR ${val("sales_closes_at", null)} > ${val("sales_opens_at", null)})`;
    const roomOk = sql`(SELECT COUNT(*) FROM ticket_types WHERE party_id = ${p} AND archived_at IS NULL) < ${MAX_ACTIVE_TYPES}`;
    const rangeOk = sql`(${val("min_people", null)} IS NULL OR ${val("max_people", null)} IS NULL OR ${val("min_people", null)} <= ${val("max_people", null)})`;
    const rs = await this.driver.batch([
      sql`INSERT INTO ticket_types (id, party_id, name, description, price, quantity, sales_opens_at, sales_closes_at, entry_from,
          staff_only, payment_instructions, sort, min_people, max_people, created_at, created_by, last_op, last_action)
        SELECT ${id}, ${p}, ${val("name", "")}, ${val("description", null)}, ${val("price", 0)}, ${val("quantity", null)},
          ${val("sales_opens_at", null)}, ${val("sales_closes_at", null)}, ${val("entry_from", null)}, ${val("staff_only", 0)},
          ${val("payment_instructions", null)}, ${val("sort", 0)}, ${val("min_people", null)}, ${val("max_people", null)}, ${now}, ${actor}, ${op}, 'type_created'
        WHERE ${ok} AND ${windowOk} AND ${roomOk} AND ${rangeOk} AND NOT EXISTS (SELECT 1 FROM ticket_types WHERE id = ${id})`,
      audit(now, actor, "type_created", "ticket_type", sql`SELECT party_id, id, rev FROM ticket_types WHERE id = ${id} AND last_op = ${op}`),
      sql`SELECT ${ok} AS session_ok, ${windowOk} AS window_ok, ${roomOk} AS room_ok, ${rangeOk} AS range_ok,
          (SELECT party_id FROM ticket_types WHERE id = ${id}) AS existing_party`,
    ]);
    if (rs[0]!.meta.changes === 1) return { status: "created" };
    const d = rs[2]!.results[0] as { session_ok: number; window_ok: number; room_ok: number; range_ok: number; existing_party: string | null };
    if (!d.session_ok) return { status: "rejected", reason: "not_allowed" };
    if (d.existing_party === p) return { status: "already" };
    if (d.existing_party !== null) return { status: "rejected", reason: "not_allowed" };
    if (!d.window_ok) return { status: "rejected", reason: "sales_close_before_open" };
    if (!d.room_ok) return { status: "rejected", reason: "too_many_types" };
    if (!d.range_ok) return { status: "rejected", reason: "people_min_above_max" };
    return { status: "rejected", reason: "not_allowed" };
  }

  /**
   * Edit (and archive / restore) a type. Places cannot go below the people already
   * holding a place of this type; a restore counts against the limit of active
   * types. A request that changes nothing writes nothing.
   */
  async update(sess: SessionRef, id: string, v: TypeValues, archived: boolean | null, now: number, actor: string, op: string): Promise<TypeChange> {
    const ok = sessionValid(sess, MANAGERS, now);
    const p = sess.partyId;
    const fields = TYPE_FIELDS.filter((f) => f in v);
    const col = (f: TypeField) => raw(f);
    const merged = (f: TypeField): Sql => (f in v ? sql`${v[f] ?? null}` : col(f));
    const sets: Sql[] = fields.map((f) => sql`${col(f)} = ${v[f] ?? null}`);
    const diffs: Sql[] = fields.map((f) => sql`${col(f)} IS NOT ${v[f] ?? null}`);
    if (archived === true) {
      sets.push(sql`archived_at = COALESCE(archived_at, ${now})`);
      diffs.push(sql`archived_at IS NULL`);
    } else if (archived === false) {
      sets.push(sql`archived_at = NULL`);
      diffs.push(sql`archived_at IS NOT NULL`);
    }
    const differs = sql`(${join(diffs, " OR ")})`;
    const windowOk = sql`(${merged("sales_opens_at")} IS NULL OR ${merged("sales_closes_at")} IS NULL
      OR ${merged("sales_closes_at")} > ${merged("sales_opens_at")})`;
    const qtyOk = "quantity" in v && v.quantity != null ? sql`${v.quantity} >= ${typeHeld(sql`${id}`)}` : sql`1`;
    const rangeOk = sql`(${merged("min_people")} IS NULL OR ${merged("max_people")} IS NULL OR ${merged("min_people")} <= ${merged("max_people")})`;
    const roomOk = archived === false
      ? sql`(archived_at IS NULL OR (SELECT COUNT(*) FROM ticket_types WHERE party_id = ${p} AND archived_at IS NULL) < ${MAX_ACTIVE_TYPES})`
      : sql`1`;
    const action = archived === true ? "type_archived" : archived === false && fields.length === 0 ? "type_restored" : "type_changed";
    const rs = await this.driver.batch([
      sql`UPDATE ticket_types SET ${join(sets, ", ")}, rev = rev + 1, last_op = ${op}, last_action = ${action}
        WHERE id = ${id} AND party_id = ${p} AND ${ok} AND ${differs} AND ${windowOk} AND ${qtyOk} AND ${roomOk} AND ${rangeOk}`,
      audit(now, actor, action, "ticket_type", sql`SELECT party_id, id, rev FROM ticket_types WHERE id = ${id} AND last_op = ${op}`,
        fields.join(",") || null),
      sql`SELECT ${ok} AS session_ok, ${differs} AS differs, ${windowOk} AS window_ok, ${roomOk} AS room_ok, ${rangeOk} AS range_ok,
          ${typeHeld(sql`${id}`)} AS held
        FROM ticket_types WHERE id = ${id} AND party_id = ${p}`,
    ]);
    if (rs[0]!.meta.changes === 1) return { status: "changed" };
    const d = rs[2]!.results[0] as undefined | { session_ok: number; differs: number; window_ok: number; room_ok: number; range_ok: number; held: number };
    if (!d) return { status: "rejected", reason: "not_found" };
    if (!d.session_ok) return { status: "rejected", reason: "not_allowed" };
    if (!d.differs) return { status: "already" };
    if (!d.window_ok) return { status: "rejected", reason: "sales_close_before_open" };
    if (!d.room_ok) return { status: "rejected", reason: "too_many_types" };
    if ("quantity" in v && v.quantity != null && (v.quantity as number) < d.held) return { status: "rejected", reason: "quantity_below_held", held: d.held };
    if (!d.range_ok) return { status: "rejected", reason: "people_min_above_max" };
    return { status: "rejected", reason: "not_allowed" };
  }
}
