// A booking is defined by order_id, never by an email address or a loaded page.
// No schema changes. Single-ticket actions retain their existing meaning.
import { audit, sessionValid, type SessionRef } from "../db";
import type { SqlDriver } from "../db/driver";
import { inList, join, sql, type Sql } from "../db/sql";

const MANAGERS = ["owner", "admin"] as const;
export interface BookingMember {
  id: string; order_id: string | null; status: string; rev: number; logged_rev: number;
  last_op: string | null; last_action: string | null;
  guest_name: string | null; guest_email: string | null; people: number;
  approved_at: number | null;
  released_at: number | null; used_at: number | null; cancelled_at: number | null;
  cancelled_by: string | null; on_hold: number | null; email_sent_at: number | null;
  email_status: string | null;
}
export type BookingSummary = { id: string; total: number; active: number; cancelled: number; deleted: number; rejected: number; used: number; pending: number; unconfirmed: number };
export const summarize = (id: string, members: BookingMember[]): BookingSummary => ({
  id, total: members.length,
  active: members.filter(m => ["pending", "approved"].includes(m.status) && !m.used_at).length,
  cancelled: members.filter(m => m.status === "cancelled" && m.approved_at != null).length,
  deleted: members.filter(m => m.status === "cancelled" && m.approved_at == null).length,
  rejected: members.filter(m => m.status === "rejected").length,
  used: members.filter(m => m.used_at != null).length,
  pending: members.filter(m => m.status === "pending").length,
  unconfirmed: members.filter(m => m.rev > m.logged_rev).length,
});

export class BookingDb {
  constructor(readonly driver: SqlDriver) {}

  async members(sess: SessionRef, id: string, now: number): Promise<BookingMember[]> {
    const r = await this.driver.all<BookingMember>(sql`SELECT t.id, t.order_id, t.status, t.rev, t.logged_rev, t.last_op, t.last_action,
      t.guest_name, t.guest_email, t.people, t.approved_at, t.released_at, t.used_at, t.cancelled_at,
      (SELECT name FROM staff WHERE id = t.cancelled_by) AS cancelled_by, t.hold_at AS on_hold,
      (SELECT MAX(sent_at) FROM outbox o WHERE o.ticket_id = t.id AND o.party_id = t.party_id
        AND o.kind IN ('ticket_released', 'ticket_link') AND o.status = 'sent') AS email_sent_at,
      (SELECT status FROM outbox o WHERE o.ticket_id = t.id AND o.party_id = t.party_id
        AND o.kind IN ('ticket_released', 'ticket_link') ORDER BY created_at DESC, id DESC LIMIT 1) AS email_status
      FROM tickets t WHERE t.party_id = ${sess.partyId}
        AND COALESCE(t.order_id, t.id) = (SELECT COALESCE(order_id, id) FROM tickets WHERE id = ${id} AND party_id = ${sess.partyId})
        AND ${sessionValid(sess, MANAGERS, now)} ORDER BY t.created_at, t.id LIMIT 11`);
    return r.results;
  }

  // One aggregate for the page, covering all statuses and pages of each booking.
  /**
   * Each listed ticket's booking (its whole order, or itself): looked up by order id and
   * ticket id through the indexes, so only the bookings' own tickets are read.
   */
  async summaries(sess: SessionRef, rows: { id: unknown; order_id?: unknown }[], now: number) {
    if (!rows.length) return new Map<string, BookingSummary>();
    const orders = [...new Set(rows.filter((r) => r.order_id).map((r) => String(r.order_id)))];
    const singles = [...new Set(rows.filter((r) => !r.order_id).map((r) => String(r.id)))];
    // Two indexed lookups (the orders' tickets by order id, single tickets by id); an OR of
    // both would make SQLite read every ticket of the party.
    const ok = sessionValid(sess, MANAGERS, now);
    const parts: Sql[] = [];
    if (orders.length) parts.push(sql`SELECT order_id AS k, status, used_at, approved_at, rev, logged_rev FROM tickets
      WHERE party_id = ${sess.partyId} AND order_id IN (${inList(orders)})`);
    if (singles.length) parts.push(sql`SELECT id AS k, status, used_at, approved_at, rev, logged_rev FROM tickets
      WHERE id IN (${inList(singles)}) AND +party_id = ${sess.partyId} AND order_id IS NULL`);
    const r = await this.driver.all<BookingSummary>(sql`SELECT t.k AS id,
      COUNT(*) AS total, SUM(t.status IN ('pending','approved') AND t.used_at IS NULL) AS active,
      SUM(t.status = 'cancelled' AND t.approved_at IS NOT NULL) AS cancelled,
      SUM(t.status = 'cancelled' AND t.approved_at IS NULL) AS deleted, SUM(t.status = 'rejected') AS rejected,
      SUM(t.used_at IS NOT NULL) AS used, SUM(t.status = 'pending') AS pending, SUM(t.rev > t.logged_rev) AS unconfirmed
      FROM (${join(parts, " UNION ALL ")}) t WHERE ${ok} GROUP BY t.k`);
    return new Map(r.results.map(x => [x.id, x]));
  }

  async cancel(sess: SessionRef, id: string, expected: {id: string; rev: number}[], actor: string, now: number, op: string) {
    // Materialise eligibility BEFORE changing any revision, so the whole UPDATE
    // succeeds together or changes nothing, including a simultaneous door scan.
    const key = sql`(SELECT COALESCE(order_id, id) FROM tickets WHERE id = ${id} AND party_id = ${sess.partyId})`;
    const group = sql`t.party_id = ${sess.partyId} AND COALESCE(t.order_id, t.id) = ${key}`;
    const snapshot = JSON.stringify(expected);
    const rs = await this.driver.batch([
      sql`WITH eligible AS MATERIALIZED (SELECT 1 WHERE ${sessionValid(sess, MANAGERS, now)}
        AND (SELECT COUNT(*) FROM tickets t WHERE ${group}) = ${expected.length}
        AND NOT EXISTS (SELECT 1 FROM tickets t WHERE ${group} AND
          (t.used_scan_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM json_each(${snapshot}) e
            WHERE json_extract(e.value, '$.id') = t.id AND json_extract(e.value, '$.rev') = t.rev))))
        UPDATE tickets SET status = 'cancelled', cancelled_at = ${now}, cancelled_by = ${actor},
          rev = rev + 1, last_op = ${op}, last_action = 'cancelled'
        WHERE party_id = ${sess.partyId} AND COALESCE(order_id, id) = ${key}
          AND status IN ('pending','approved') AND used_scan_id IS NULL AND EXISTS (SELECT 1 FROM eligible)`,
      audit(now, actor, "cancelled", "ticket", sql`SELECT party_id, id, rev FROM tickets
        WHERE party_id = ${sess.partyId} AND last_op = ${op} AND last_action = 'cancelled'`, "Whole booking cancelled"),
    ]);
    return rs[0]!.meta.changes;
  }
}
