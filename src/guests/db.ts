// Guest sign-up, the approval queue, release, name transfer and export. Like
// src/db/index.ts and src/db/tickets.ts, every rule that decides whether a change
// happens is inside the statement that makes it: capacity, the session check, the
// ticket's state. Multi-ticket changes are ONE batch (one transaction).
//
// Capacity (brief section 10): places held = people on pending + approved tickets.
//  - Sign-up inserts only if held + people <= capacity (and people <= the party's
//    maximum per ticket), in the INSERT itself.
//  - Approval changes a ticket only if the approved people + its people <= capacity,
//    in the UPDATE itself (so lowering the capacity later can never let approvals
//    pass it).
// D1 runs one write transaction at a time per database, so two sign-ups at once are
// checked one after the other and can never pass the capacity together.

import type { SqlDriver } from "../db/driver";
import { audit, sessionValid, type SessionRef } from "../db/index";
import { inList, join, sql, type Sql } from "../db/sql";
import { outboxInsert, type OutboxRow } from "../outbox";

const MANAGERS = ["owner", "admin"] as const;

export const held = (partyId: Sql) =>
  sql`(SELECT COALESCE(SUM(h.people), 0) FROM tickets h WHERE h.party_id = ${partyId} AND h.status IN ('pending', 'approved'))`;
const approvedPeople = (partyId: string) =>
  sql`(SELECT COALESCE(SUM(a.people), 0) FROM tickets a WHERE a.party_id = ${partyId} AND a.status = 'approved')`;

export interface SignupParty {
  id: string;
  name: string;
  capacity: number;
  max_people_per_ticket: number;
  guest_form: string | null;
  held: number;
  /** Party of the ticket with this sign-up's id, if it exists already (a retry). */
  existing_party: string | null;
}

export interface GuestTicket {
  id: string;
  party_id: string;
  party_name: string;
  status: string;
  people: number;
  guest_name: string | null;
  qr_version: number;
  link_version: number;
  released_at: number | null;
  hold_at: number | null;
  used_at: number | null;
  reject_reason: string | null;
}

export type BulkResult = Record<string, "done" | "already" | "refused">;

export const MAX_BULK = 20;

export class GuestDb {
  constructor(readonly driver: SqlDriver) {}

  // ------------------------------------------------------------ guests

  /** One read before sign-up: the party, its form, places held, and whether this sign-up already exists. */
  async signupParty(partyId: string, ticketId: string): Promise<SignupParty | null> {
    const r = await this.driver.all<SignupParty>(sql`SELECT p.id, p.name, p.capacity, p.max_people_per_ticket, p.guest_form,
        ${held(sql`p.id`)} AS held, (SELECT party_id FROM tickets WHERE id = ${ticketId}) AS existing_party
      FROM parties p WHERE p.id = ${partyId}`);
    return r.results[0] ?? null;
  }

  /**
   * The sign-up batch: insert the pending ticket only if the party has room for
   * its people (same statement), audit it, and read back. A retry with the same
   * ticket id inserts nothing and is recognized by the read-back.
   */
  async signup(a: {
    id: string; partyId: string; people: number; name: string; email: string; answers: string | null;
    screenshotKey: string | null; now: number; op: string;
  }): Promise<"created" | "already" | "full" | "refused"> {
    const rs = await this.driver.batch([
      sql`INSERT INTO tickets (id, party_id, status, people, guest_name, guest_email, answers, screenshot_key, created_at, last_op, last_action)
        SELECT ${a.id}, p.id, 'pending', ${a.people}, ${a.name}, ${a.email}, ${a.answers}, ${a.screenshotKey}, ${a.now}, ${a.op}, 'ticket_requested'
        FROM parties p
        WHERE p.id = ${a.partyId} AND ${a.people} <= p.max_people_per_ticket
          AND ${held(sql`p.id`)} + ${a.people} <= p.capacity
          AND NOT EXISTS (SELECT 1 FROM tickets x WHERE x.id = ${a.id})`,
      audit(a.now, null, "ticket_requested", "ticket", sql`SELECT party_id, id, rev FROM tickets WHERE id = ${a.id} AND last_op = ${a.op}`),
      sql`SELECT t.party_id, t.last_op, ${held(sql`p.id`)} AS held, p.capacity
        FROM parties p LEFT JOIN tickets t ON t.id = ${a.id} WHERE p.id = ${a.partyId}`,
    ]);
    const row = rs[2]!.results[0] as { party_id: string | null; last_op: string | null; held: number; capacity: number } | undefined;
    if (rs[0]!.meta.changes === 1) return "created";
    if (row?.party_id === a.partyId) return "already";
    if (row && row.party_id === null && row.held + a.people > row.capacity) return "full";
    return "refused";
  }

  /** The ticket named by a verified link, with its party's name. */
  async guestTicket(partyId: string, ticketId: string): Promise<GuestTicket | null> {
    const r = await this.driver.all<GuestTicket>(sql`SELECT t.id, t.party_id, p.name AS party_name, t.status, t.people, t.guest_name,
        t.qr_version, t.link_version, t.released_at, t.hold_at, t.used_at, t.reject_reason
      FROM tickets t JOIN parties p ON p.id = t.party_id WHERE t.id = ${ticketId} AND t.party_id = ${partyId}`);
    return r.results[0] ?? null;
  }

  /** "Resend my ticket link": the party's (up to 5 most recent) tickets for this email. */
  async ticketsByEmail(partyId: string, email: string) {
    const r = await this.driver.all<{ id: string; link_version: number; party_name: string }>(
      sql`SELECT t.id, t.link_version, p.name AS party_name FROM tickets t JOIN parties p ON p.id = t.party_id
        WHERE t.party_id = ${partyId} AND t.guest_email = ${email} ORDER BY t.created_at DESC LIMIT 5`,
    );
    return r.results;
  }

  /**
   * Adds a "ticket_link" email unless one with the same id exists. The id is
   * derived from party + email + 10-minute window, so at most one such email per
   * address per window, checked by primary key (no outbox index, no scan).
   */
  async addLinkEmail(row: OutboxRow, tickets: { id: string; link_version: number }[]): Promise<boolean> {
    const stillThere = tickets.map((t) => sql`EXISTS (SELECT 1 FROM tickets WHERE id = ${t.id} AND party_id = ${row.partyId}
      AND guest_email = ${row.toEmail} AND link_version = ${t.link_version})`);
    const guard = sql`NOT EXISTS (SELECT 1 FROM outbox WHERE id = ${row.id}) AND (${join(stillThere, " OR ")})`;
    const r = await this.driver.all(outboxInsert(row, guard));
    return r.meta.changes === 1;
  }

  // ------------------------------------------------------- owner/admin

  async setForm(sess: SessionRef, form: string, now: number, actor: string, op: string): Promise<boolean> {
    const ok = sessionValid(sess, MANAGERS, now);
    const rs = await this.driver.batch([
      sql`UPDATE parties SET guest_form = ${form}, rev = rev + 1, last_op = ${op}, last_action = 'guest_form_changed'
        WHERE id = ${sess.partyId} AND ${ok}`,
      audit(now, actor, "guest_form_changed", "party", sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${sess.partyId} AND last_op = ${op}`),
    ]);
    return rs[0]!.meta.changes === 1;
  }

  async getForm(sess: SessionRef, now: number) {
    const r = await this.driver.all<{ guest_form: string | null; capacity: number; max_people_per_ticket: number; held: number }>(
      sql`SELECT guest_form, capacity, max_people_per_ticket, ${held(sql`p.id`)} AS held FROM parties p
        WHERE p.id = ${sess.partyId} AND ${sessionValid(sess, MANAGERS, now)}`,
    );
    return r.results[0] ?? null;
  }

  /** Approval queue and other lists: the party's tickets with one status, oldest first, paged by (created_at, id). */
  async list(sess: SessionRef, status: string, after: { at: number; id: string } | null, limit: number, now: number) {
    const cursor = after ? sql`AND (created_at > ${after.at} OR (created_at = ${after.at} AND id > ${after.id}))` : sql``;
    const r = await this.driver.all(sql`SELECT id, status, people, guest_name, guest_email, answers, screenshot_key IS NOT NULL AS has_screenshot,
        created_at, approved_at, released_at, reject_reason, hold_at, used_at, qr_version, rev
      FROM tickets WHERE party_id = ${sess.partyId} AND status = ${status} ${cursor} AND ${sessionValid(sess, MANAGERS, now)}
      ORDER BY created_at, id LIMIT ${limit}`);
    return r.results;
  }

  /** The screenshot key of one of the party's tickets (owner/admin only; checked in the query). */
  async screenshotKey(sess: SessionRef, id: string, now: number): Promise<string | null> {
    const r = await this.driver.all<{ screenshot_key: string | null }>(sql`SELECT screenshot_key FROM tickets
      WHERE id = ${id} AND party_id = ${sess.partyId} AND ${sessionValid(sess, MANAGERS, now)}`);
    return r.results[0]?.screenshot_key ?? null;
  }

  /** One batch: the changes, one audit statement for all, and a read-back of every ticket named. */
  private async bulk(sess: SessionRef, ids: string[], action: string, updates: Sql[], extra: Sql[], now: number, actor: string,
    op: string, detail: string | null, isDone: (r: Record<string, unknown>) => boolean): Promise<BulkResult> {
    const rs = await this.driver.batch([
      ...updates,
      ...extra,
      audit(now, actor, action, "ticket",
        sql`SELECT party_id, id, rev FROM tickets WHERE party_id = ${sess.partyId} AND id IN (${inList(ids)}) AND last_op = ${op}`, detail),
      sql`SELECT * FROM tickets WHERE party_id = ${sess.partyId} AND id IN (${inList(ids)})`,
    ]);
    const rows = new Map((rs.at(-1)!.results as Record<string, unknown>[]).map((r) => [String(r.id), r]));
    const out: BulkResult = {};
    ids.forEach((id, i) => {
      const r = rows.get(id);
      out[id] = rs[i]!.meta.changes === 1 ? "done" : r && isDone(r) ? "already" : "refused";
    });
    return out;
  }

  /** Approve one or many pending tickets; each only if the approved people stay within capacity. */
  approve(sess: SessionRef, ids: string[], now: number, actor: string, op: string) {
    const ok = sessionValid(sess, MANAGERS, now);
    const cap = sql`(SELECT capacity FROM parties WHERE id = ${sess.partyId})`;
    return this.bulk(sess, ids, "approved", ids.map((id) => sql`UPDATE tickets SET status = 'approved', approved_at = ${now}, approved_by = ${actor},
        rev = rev + 1, last_op = ${op}, last_action = 'approved'
      WHERE id = ${id} AND party_id = ${sess.partyId} AND status = 'pending'
        AND ${approvedPeople(sess.partyId)} + people <= ${cap} AND ${ok}`), [], now, actor, op, null,
      (r) => r.status === "approved");
  }

  /** Reject one or many pending tickets with a reason the guest sees. */
  reject(sess: SessionRef, ids: string[], reason: string | null, now: number, actor: string, op: string) {
    const ok = sessionValid(sess, MANAGERS, now);
    return this.bulk(sess, ids, "rejected", ids.map((id) => sql`UPDATE tickets SET status = 'rejected', reject_reason = ${reason},
        rejected_at = ${now}, rejected_by = ${actor}, rev = rev + 1, last_op = ${op}, last_action = 'rejected'
      WHERE id = ${id} AND party_id = ${sess.partyId} AND status = 'pending' AND ${ok}`), [], now, actor, op, reason,
      (r) => r.status === "rejected");
  }

  /** Approved, unreleased tickets among `ids` (to prepare their emails before the release batch). */
  async releasable(sess: SessionRef, ids: string[], now: number) {
    const r = await this.driver.all<{ id: string; guest_email: string | null; guest_name: string | null; link_version: number; party_name: string }>(
      sql`SELECT t.id, t.guest_email, t.guest_name, t.link_version, p.name AS party_name FROM tickets t JOIN parties p ON p.id = t.party_id
        WHERE t.party_id = ${sess.partyId} AND t.id IN (${inList(ids)}) AND t.status = 'approved' AND t.released_at IS NULL
          AND ${sessionValid(sess, MANAGERS, now)}`,
    );
    return r.results;
  }

  /**
   * "Send QR": release one or many approved tickets. Each release adds its email
   * (outbox, kind ticket_released) in the same batch, guarded so the row exists
   * only if this operation released that ticket.
   */
  release(sess: SessionRef, ids: string[], emails: OutboxRow[], now: number, actor: string, op: string) {
    const ok = sessionValid(sess, MANAGERS, now);
    return this.bulk(sess, ids, "released", ids.map((id) => sql`UPDATE tickets SET released_at = ${now}, released_by = ${actor},
        rev = rev + 1, last_op = ${op}, last_action = 'released'
      WHERE id = ${id} AND party_id = ${sess.partyId} AND status = 'approved' AND released_at IS NULL AND ${ok}`),
    emails.map((e) => outboxInsert(e, sql`EXISTS (SELECT 1 FROM tickets WHERE id = ${e.ticketId} AND party_id = ${sess.partyId}
        AND last_op = ${op} AND last_action = 'released' AND guest_email = ${e.toEmail})`)),
    now, actor, op, null, (r) => r.status === "approved" && r.released_at != null);
  }

  async ticket(sess: SessionRef, id: string, now: number) {
    const r = await this.driver.all<{ id: string; status: string; guest_name: string | null; guest_email: string | null;
      link_version: number; used_scan_id: string | null; last_op: string | null; last_action: string | null; party_name: string }>(
      sql`SELECT t.id, t.status, t.guest_name, t.guest_email, t.link_version, t.used_scan_id, t.last_op, t.last_action, p.name AS party_name
        FROM tickets t JOIN parties p ON p.id = t.party_id
        WHERE t.id = ${id} AND t.party_id = ${sess.partyId} AND ${sessionValid(sess, MANAGERS, now)}`,
    );
    return r.results[0] ?? null;
  }

  /**
   * Name transfer (feature 13): new name (and optionally email), and a reissue in
   * the same statement: qr_version + 1 (the old QR stops working) and
   * link_version + 1 (the old link stops working). Only if the link version is
   * still the one the new link was signed for. The new holder's link email is
   * added in the same batch, guarded by this operation.
   */
  async transfer(sess: SessionRef, a: { id: string; name: string; email: string | null; fromLinkVersion: number; linkEmail: OutboxRow | null },
    now: number, actor: string, op: string): Promise<boolean> {
    const ok = sessionValid(sess, MANAGERS, now);
    const rs = await this.driver.batch([
      sql`UPDATE tickets SET guest_name = ${a.name}, guest_email = COALESCE(${a.email}, guest_email),
          qr_version = qr_version + 1, link_version = link_version + 1, rev = rev + 1, last_op = ${op}, last_action = 'name_transferred'
        WHERE id = ${a.id} AND party_id = ${sess.partyId} AND status IN ('pending', 'approved') AND used_scan_id IS NULL
          AND link_version = ${a.fromLinkVersion} AND ${ok}`,
      audit(now, actor, "name_transferred", "ticket", sql`SELECT party_id, id, rev FROM tickets WHERE id = ${a.id} AND last_op = ${op}`),
      ...(a.linkEmail ? [outboxInsert(a.linkEmail, sql`EXISTS (SELECT 1 FROM tickets WHERE id = ${a.id} AND last_op = ${op}
        AND last_action = 'name_transferred' AND guest_email = ${a.linkEmail.toEmail})`)] : []),
    ]);
    return rs[0]!.meta.changes === 1;
  }

  /**
   * Guest list export (feature 6), paged by ticket id: who approved, released and
   * scanned each ticket, and when. The browser builds the CSV.
   */
  async exportPage(sess: SessionRef, after: string, limit: number, now: number) {
    const r = await this.driver.all(sql`SELECT t.id, t.status, t.people, t.guest_name, t.guest_email, t.answers, t.created_at,
        t.approved_at, ap.name AS approved_by, t.rejected_at, rj.name AS rejected_by, t.reject_reason,
        t.released_at, rl.name AS released_by, t.used_at, us.name AS scanned_by, t.qr_version, t.hold_at
      FROM tickets t
        LEFT JOIN staff ap ON ap.id = t.approved_by LEFT JOIN staff rj ON rj.id = t.rejected_by
        LEFT JOIN staff rl ON rl.id = t.released_by LEFT JOIN staff us ON us.id = t.used_by
      WHERE t.party_id = ${sess.partyId} AND t.id > ${after} AND ${sessionValid(sess, MANAGERS, now)}
      ORDER BY t.id LIMIT ${limit}`);
    return r.results;
  }
}
