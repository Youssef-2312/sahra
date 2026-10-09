// Party details in the main database. As in src/db/index.ts, every rule that
// decides whether a change happens is inside the statement that makes it: the
// session check, capacity versus places held, the address lock, end after start,
// and a reveal time for at_time mode.

import { audit, sessionValid, type SessionRef } from "../db";
import type { SqlDriver } from "../db/driver";
import { join, raw, sql, type Sql } from "../db/sql";
import type { PartyDetailsRow } from "./details";
import { EDITABLE, type EditValues, type EditableField } from "./input";
import { announceInsert, announceRecipients, type Audience, MAX_NOTICES_PER_EDIT, noticeInsert, noticeRecipients } from "./notice";

const COLUMNS = `id, name, description, starts_at, ends_at, time_zone, venue_name, address, map_url, rules, cancellation_policy,
  payment_instructions, capacity, max_people_per_ticket, address_mode, reveal_at, revealed_at, address_locked_at,
  email_ticket_subject, email_ticket_body, email_link_subject, email_link_body,
  registration_opens_at, registration_closes_at, max_tickets_per_email, support_phone, support_email, support_note, review_time, cancelled_at, cancel_reason, rev`;

/** Places held: people on pending and approved tickets (used ones are approved too). */
function heldPlaces(partyId: string): Sql {
  return sql`(SELECT COALESCE(SUM(people), 0) FROM tickets WHERE party_id = ${partyId} AND status IN ('pending', 'approved'))`;
}

export type EditResult =
  | { status: "changed" | "already"; notices: number | null; notices_not_queued: number }
  | { status: "rejected"; reason: "not_allowed" | "end_before_start" | "registration_close_before_open" | "reveal_time_required" | "address_locked" | "capacity_below_held"; held?: number };

export class PartyDb {
  constructor(readonly driver: SqlDriver) {}

  async get(partyId: string): Promise<(PartyDetailsRow & { rev: number }) | null> {
    const r = await this.driver.all<PartyDetailsRow & { rev: number }>(sql`SELECT ${raw(COLUMNS)} FROM parties WHERE id = ${partyId}`);
    return r.results[0] ?? null;
  }

  /**
   * Applies the given fields (owner/admin) in one batch: the conditional UPDATE,
   * its audit row, optionally the notice rows, and a read-back that says why
   * nothing changed. A request that changes nothing (e.g. a retry after "pending")
   * writes nothing.
   */
  async edit(sess: SessionRef, actor: string, values: EditValues, now: number, op: string,
    notice: null | { subject: string; body: string }): Promise<EditResult> {
    const ok = sessionValid(sess, ["owner", "admin"], now);
    const p = sess.partyId;
    const fields = EDITABLE.filter((f) => f in values);
    // Column names come from the fixed EDITABLE list, never from input.
    const col = (f: EditableField) => raw(f);
    const merged = (f: EditableField): Sql => (f in values ? sql`${values[f] ?? null}` : col(f));
    const differs = sql`NOT (${join(fields.map((f) => sql`${col(f)} IS ${values[f] ?? null}`), " AND ")})`;
    const timesOk = sql`(${merged("starts_at")} IS NULL OR ${merged("ends_at")} IS NULL OR ${merged("ends_at")} > ${merged("starts_at")})`;
    const revealOk = sql`(${merged("address_mode")} != 'at_time' OR ${merged("reveal_at")} IS NOT NULL)`;
    const regOk = sql`(${merged("registration_opens_at")} IS NULL OR ${merged("registration_closes_at")} IS NULL
      OR ${merged("registration_closes_at")} > ${merged("registration_opens_at")})`;
    const lockOk = sql`(address_locked_at IS NULL OR address_locked_at > ${now} OR (venue_name IS ${merged("venue_name")}
      AND address IS ${merged("address")} AND map_url IS ${merged("map_url")} AND address_locked_at IS ${merged("address_locked_at")}))`;
    // Only a capacity edit reads the party's tickets.
    const capOk = "capacity" in values ? sql`${values.capacity} >= ${heldPlaces(p)}` : sql`1`;
    const set = join(fields.map((f) => sql`${col(f)} = ${values[f] ?? null}`), ", ");
    const changed = sql`EXISTS (SELECT 1 FROM parties WHERE id = ${p} AND last_op = ${op})`;

    const stmts: Sql[] = [
      sql`UPDATE parties SET ${set}, rev = rev + 1, last_op = ${op}, last_action = 'party_edited'
        WHERE id = ${p} AND ${ok} AND ${differs} AND ${timesOk} AND ${regOk} AND ${revealOk} AND ${lockOk} AND ${capOk}`,
      audit(now, actor, "party_edited", "party", sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${p} AND last_op = ${op}`,
        fields.join(",")),
    ];
    if (notice) stmts.push(noticeInsert({ partyId: p, op, subject: notice.subject, body: notice.body, now, createdBy: actor }, changed));
    stmts.push(sql`SELECT ${ok} AS session_ok, ${differs} AS differs, ${timesOk} AS times_ok, ${regOk} AS reg_ok, ${revealOk} AS reveal_ok,
        ${lockOk} AS lock_ok, ${"capacity" in values ? heldPlaces(p) : sql`NULL`} AS held, last_op,
        ${notice ? sql`(SELECT COUNT(*) FROM (${noticeRecipients(p)}))` : sql`NULL`} AS recipients
      FROM parties WHERE id = ${p}`);
    const rs = await this.driver.batch(stmts);
    const d = rs.at(-1)!.results[0] as undefined | {
      session_ok: number; differs: number; times_ok: number; reg_ok: number; reveal_ok: number; lock_ok: number; held: number | null; last_op: string; recipients: number | null;
    };
    if (rs[0]!.meta.changes === 1) {
      const queued = notice ? rs[2]!.meta.changes : null;
      return { status: "changed", notices: queued, notices_not_queued: notice && d?.recipients != null ? d.recipients - (queued ?? 0) : 0 };
    }
    if (!d || !d.session_ok) return { status: "rejected", reason: "not_allowed" };
    if (!d.times_ok) return { status: "rejected", reason: "end_before_start" };
    if (!d.reg_ok) return { status: "rejected", reason: "registration_close_before_open" };
    if (!d.reveal_ok) return { status: "rejected", reason: "reveal_time_required" };
    if (!d.lock_ok && d.differs) return { status: "rejected", reason: "address_locked" };
    if (d.held !== null && (values.capacity as number) < d.held) return { status: "rejected", reason: "capacity_below_held", held: d.held };
    if (!d.differs) return { status: "already", notices: null, notices_not_queued: 0 };
    return { status: "rejected", reason: "not_allowed" };
  }

  /** "Reveal now" (manual mode, owner/admin). Idempotent: a second press changes nothing. */
  async revealNow(sess: SessionRef, actor: string, now: number, op: string) {
    const ok = sessionValid(sess, ["owner", "admin"], now);
    const p = sess.partyId;
    const rs = await this.driver.batch([
      sql`UPDATE parties SET revealed_at = ${now}, rev = rev + 1, last_op = ${op}, last_action = 'address_revealed'
        WHERE id = ${p} AND address_mode = 'manual' AND revealed_at IS NULL AND ${ok}`,
      audit(now, actor, "address_revealed", "party", sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${p} AND last_op = ${op}`),
      sql`SELECT address_mode, revealed_at, ${ok} AS session_ok FROM parties WHERE id = ${p}`,
    ]);
    const row = rs[2]!.results[0] as undefined | { address_mode: string; revealed_at: number | null; session_ok: number };
    if (rs[0]!.meta.changes === 1) return { status: "revealed" as const, revealed_at: now };
    if (!row || !row.session_ok) return { status: "rejected" as const, reason: "not_allowed" };
    if (row.address_mode !== "manual") return { status: "rejected" as const, reason: "not_manual_mode" };
    return { status: "already" as const, revealed_at: row.revealed_at };
  }
  /**
   * Announcement to guests (owner/admin): the outbox rows (awaiting approval), an
   * audit row when any was queued, and the counts, in one batch. The session is
   * checked inside the insert. The same op queues nobody twice.
   */
  /**
   * Cancels the party (owner only; brainstorm idea 14), in one batch: marks it
   * cancelled with the reason (new requests are refused from then on, checked in
   * the sign-up INSERT; admission is paused by the route BEFORE this), and, when
   * asked, records "refund due" for every paid ticket still pending or approved
   * (price per person x people). A retry with the same op changes nothing more.
   * Cannot be undone.
   */
  async cancel(sess: SessionRef, actor: string, a: { reason: string | null; markRefunds: boolean }, now: number, op: string) {
    const ok = sessionValid(sess, ["owner"], now);
    const p = sess.partyId;
    const rs = await this.driver.batch([
      sql`UPDATE parties SET cancelled_at = ${now}, cancel_reason = ${a.reason}, rev = rev + 1, last_op = ${op}, last_action = 'party_cancelled'
        WHERE id = ${p} AND cancelled_at IS NULL AND ${ok}`,
      audit(now, actor, "party_cancelled", "party", sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${p} AND last_op = ${op}`, a.reason),
      ...(a.markRefunds ? [sql`INSERT INTO refunds (ticket_id, party_id, amount, state, created_at, updated_at, updated_by)
          SELECT t.id, t.party_id, COALESCE(t.price, 0) * t.people, 'due', ${now}, ${now}, ${actor}
          FROM tickets t WHERE t.party_id = ${p} AND t.status IN ('pending', 'approved') AND COALESCE(t.price, 0) > 0
            AND EXISTS (SELECT 1 FROM parties WHERE id = ${p} AND cancelled_at IS NOT NULL) AND ${ok}
          ON CONFLICT (ticket_id) DO NOTHING`] : []),
      sql`SELECT cancelled_at, ${ok} AS ok, (SELECT COUNT(*) FROM refunds WHERE party_id = ${p} AND state = 'due') AS due
        FROM parties WHERE id = ${p}`,
    ]);
    const row = rs[rs.length - 1]!.results[0] as undefined | { cancelled_at: number | null; ok: number; due: number };
    if (!row || Number(row.ok) !== 1) return { status: "rejected" as const, due: 0 };
    return { status: rs[0]!.meta.changes === 1 ? "cancelled" as const : "already" as const, due: Number(row.due) };
  }

  /** The party's refunds (owner and admin), with what the list needs to find the guest. */
  async refunds(sess: SessionRef, now: number) {
    const r = await this.driver.all<{ ticket_id: string; amount: number; state: string; updated_at: number; guest_name: string | null; guest_email: string | null; people: number; status: string; by_name: string | null }>(
      sql`SELECT r.ticket_id, r.amount, r.state, r.updated_at, t.guest_name, t.guest_email, t.people, t.status,
          (SELECT name FROM staff WHERE id = r.updated_by) AS by_name
        FROM refunds r JOIN tickets t ON t.id = r.ticket_id
        WHERE r.party_id = ${sess.partyId} AND ${sessionValid(sess, ["owner", "admin"], now)}
        ORDER BY r.state = 'done', t.guest_name, r.ticket_id LIMIT 2000`);
    return r.results;
  }

  /**
   * Marks one ticket's refund "due" or "done" (owner and admin). "due" also adds a
   * row for a paid ticket that has none (a guest who cancelled on their own).
   * Audited. Returns false when the ticket is not this party's paid ticket.
   */
  async setRefund(sess: SessionRef, actor: string, ticketId: string, state: "due" | "done", now: number) {
    const ok = sessionValid(sess, ["owner", "admin"], now);
    const p = sess.partyId;
    const rs = await this.driver.batch([
      sql`INSERT INTO refunds (ticket_id, party_id, amount, state, created_at, updated_at, updated_by)
        SELECT t.id, t.party_id, COALESCE(t.price, 0) * t.people, ${state}, ${now}, ${now}, ${actor}
        FROM tickets t WHERE t.id = ${ticketId} AND t.party_id = ${p} AND COALESCE(t.price, 0) > 0 AND ${ok}
        ON CONFLICT (ticket_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, updated_by = excluded.updated_by
          WHERE refunds.party_id = ${p} AND refunds.state != excluded.state`,
      sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
        SELECT party_id, ${now}, ${actor}, ${state === "done" ? "refund_done" : "refund_due"}, 'ticket', ticket_id, NULL, CAST(amount AS TEXT)
        FROM refunds WHERE ticket_id = ${ticketId} AND party_id = ${p} AND updated_at = ${now} AND state = ${state} AND ${ok}`,
      sql`SELECT state FROM refunds WHERE ticket_id = ${ticketId} AND party_id = ${p} AND ${ok}`,
    ]);
    return (rs[2]!.results[0] as { state?: string } | undefined)?.state === state;
  }

  async announce(sess: SessionRef, a: { op: string; audience: Audience; typeId: string | null; subject: string; body: string },
    actor: string, now: number) {
    const ok = sessionValid(sess, ["owner", "admin"], now);
    const p = sess.partyId;
    const prefix = `announce:${a.op}:`;
    // This announcement's rows, by primary-key range (ticket ids are A-Z and 2-7, all below "~").
    const mine = sql`SELECT 1 FROM outbox WHERE id > ${prefix} AND id < ${`${prefix}~`} AND party_id = ${p}`;
    // Before the insert, in the same transaction: audit only when this call will queue someone new.
    const someoneNew = sql`EXISTS (SELECT 1 FROM (${announceRecipients(p, a.audience, a.typeId)} ORDER BY id LIMIT ${MAX_NOTICES_PER_EDIT}) r
      WHERE NOT EXISTS (SELECT 1 FROM outbox o WHERE o.id = ${prefix} || r.id))`;
    const rs = await this.driver.batch([
      audit(now, actor, "announcement_queued", "party",
        sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${p} AND ${ok} AND ${someoneNew}`, a.op),
      announceInsert({ partyId: p, op: a.op, audience: a.audience, typeId: a.typeId, subject: a.subject, body: a.body, now, createdBy: actor }, ok),
      sql`SELECT ${ok} AS session_ok, (SELECT COUNT(*) FROM (${mine})) AS queued,
          (SELECT COUNT(*) FROM (${announceRecipients(p, a.audience, a.typeId)})) AS recipients`,
    ]);
    const d = rs[2]!.results[0] as { session_ok: number; queued: number; recipients: number };
    return { ok: !!d.session_ok, queued: Number(d.queued), recipients: Number(d.recipients), new_rows: rs[1]!.meta.changes };
  }
}
