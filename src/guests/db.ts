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
import { isBase32 } from "../lib/crypto";
import { outboxInsert, type OutboxRow } from "../outbox";
import { hasPublicTypes, onSale, typeApproved, typeHeld } from "./types";

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
  registration_opens_at: number | null;
  registration_closes_at: number | null;
  max_tickets_per_email: number | null;
  /** Pending + approved tickets of the party for the given email (0 without one). */
  email_tickets: number;
  /** 1 when the party has public ticket types: a request must then name one. */
  has_types: number;
  payment_instructions: string | null;
  /** For the chosen type (if any): 1 when on sale to guests now, and its places left (NULL = no limit of its own). */
  type_on_sale: number | null;
  type_left: number | null;
}

/** Why a sign-up was not stored (the same rules as the insert, read in the same batch). */
export type SignupRefusal = "registration_not_open" | "registration_closed" | "email_limit" | "type_required" | "type_unavailable"
  | "type_full" | "full" | "refused";

/** The registration rules of a party row aliased `p`, at `now`, for one email (all inside SQL). */
function registrationRules(now: number, email: string) {
  const emailCount = sql`(SELECT COUNT(*) FROM tickets e WHERE e.party_id = p.id AND e.guest_email = ${email} AND e.status IN ('pending', 'approved'))`;
  return {
    opened: sql`(p.registration_opens_at IS NULL OR p.registration_opens_at <= ${now})`,
    notClosed: sql`(p.registration_closes_at IS NULL OR p.registration_closes_at > ${now})`,
    emailOk: sql`(p.max_tickets_per_email IS NULL OR ${emailCount} < p.max_tickets_per_email)`,
  };
}

/** The chosen type (or none) is allowed for a guest request of `people` at `now`. */
function typeRules(typeId: string | null, people: number, now: number) {
  if (typeId === null) {
    const none = sql`NOT ${hasPublicTypes(sql`p.id`)}`;
    return { chosenOk: none, placesOk: sql`1`, price: sql`NULL` };
  }
  const tt = sql`FROM ticket_types tt WHERE tt.id = ${typeId} AND tt.party_id = p.id`;
  return {
    chosenOk: sql`EXISTS (SELECT 1 ${tt} AND ${onSale(now)})`,
    placesOk: sql`EXISTS (SELECT 1 ${tt} AND (tt.quantity IS NULL OR ${typeHeld(sql`tt.id`)} + ${people} <= tt.quantity))`,
    price: sql`(SELECT tt.price ${tt})`,
  };
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
  type_name: string | null;
  price: number | null;
}

export type BulkResult = Record<string, "done" | "already" | "refused">;

export const MAX_BULK = 20;

export class GuestDb {
  constructor(readonly driver: SqlDriver) {}

  // ------------------------------------------------------------ guests

  /** One read before sign-up: the party, its form, places held, and whether this sign-up already exists. */
  async signupParty(partyId: string, ticketId: string, o: { email?: string; typeId?: string | null; now?: number } = {}): Promise<SignupParty | null> {
    const email = o.email ?? null;
    const typeId = o.typeId ?? null;
    const now = o.now ?? 0;
    const tt = sql`FROM ticket_types tt WHERE tt.id = ${typeId} AND tt.party_id = p.id`;
    const r = await this.driver.all<SignupParty>(sql`SELECT p.id, p.name, p.capacity, p.max_people_per_ticket, p.guest_form,
        ${held(sql`p.id`)} AS held, (SELECT party_id FROM tickets WHERE id = ${ticketId}) AS existing_party,
        p.registration_opens_at, p.registration_closes_at, p.max_tickets_per_email, p.payment_instructions,
        ${email === null ? sql`0` : sql`(SELECT COUNT(*) FROM tickets e WHERE e.party_id = p.id AND e.guest_email = ${email} AND e.status IN ('pending', 'approved'))`} AS email_tickets,
        ${hasPublicTypes(sql`p.id`)} AS has_types,
        ${typeId === null ? sql`NULL` : sql`EXISTS (SELECT 1 ${tt} AND ${onSale(now)})`} AS type_on_sale,
        ${typeId === null ? sql`NULL` : sql`(SELECT tt.quantity - ${typeHeld(sql`tt.id`)} ${tt})`} AS type_left
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
    screenshotKey: string | null; typeId: string | null; now: number; op: string;
  }): Promise<"created" | "already" | SignupRefusal> {
    const reg = registrationRules(a.now, a.email);
    const ty = typeRules(a.typeId, a.people, a.now);
    const roomOk = sql`${held(sql`p.id`)} + ${a.people} <= p.capacity`;
    const rs = await this.driver.batch([
      sql`INSERT INTO tickets (id, party_id, status, people, guest_name, guest_email, answers, screenshot_key, type_id, price,
          created_at, last_op, last_action)
        SELECT ${a.id}, p.id, 'pending', ${a.people}, ${a.name}, ${a.email}, ${a.answers}, ${a.screenshotKey}, ${a.typeId}, ${ty.price},
          ${a.now}, ${a.op}, 'ticket_requested'
        FROM parties p
        WHERE p.id = ${a.partyId} AND ${a.people} <= p.max_people_per_ticket AND ${roomOk}
          AND ${reg.opened} AND ${reg.notClosed} AND ${reg.emailOk} AND ${ty.chosenOk} AND ${ty.placesOk}
          AND NOT EXISTS (SELECT 1 FROM tickets x WHERE x.id = ${a.id})`,
      audit(a.now, null, "ticket_requested", "ticket", sql`SELECT party_id, id, rev FROM tickets WHERE id = ${a.id} AND last_op = ${a.op}`),
      // Why nothing was stored, from the same rules on the same state.
      sql`SELECT (SELECT party_id FROM tickets WHERE id = ${a.id}) AS existing_party,
          CASE
            WHEN NOT ${reg.opened} THEN 'registration_not_open'
            WHEN NOT ${reg.notClosed} THEN 'registration_closed'
            WHEN NOT ${reg.emailOk} THEN 'email_limit'
            WHEN NOT ${ty.chosenOk} THEN ${a.typeId === null ? "type_required" : "type_unavailable"}
            WHEN NOT ${ty.placesOk} THEN 'type_full'
            WHEN NOT ${roomOk} THEN 'full'
            ELSE 'refused'
          END AS why
        FROM parties p WHERE p.id = ${a.partyId}`,
    ]);
    if (rs[0]!.meta.changes === 1) return "created";
    const row = rs[2]!.results[0] as { existing_party: string | null; why: SignupRefusal } | undefined;
    if (row?.existing_party === a.partyId) return "already";
    if (!row || row.existing_party !== null) return "refused";
    return row.why;
  }

  /** The ticket named by a verified link, with its party's name. */
  async guestTicket(partyId: string, ticketId: string): Promise<GuestTicket | null> {
    const r = await this.driver.all<GuestTicket>(sql`SELECT t.id, t.party_id, p.name AS party_name, t.status, t.people, t.guest_name,
        t.qr_version, t.link_version, t.released_at, t.hold_at, t.used_at, t.reject_reason,
        (SELECT name FROM ticket_types WHERE id = t.type_id) AS type_name, t.price
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
    const cursor = after ? sql`AND (t.created_at > ${after.at} OR (t.created_at = ${after.at} AND t.id > ${after.id}))` : sql``;
    // same_email: the address's other pending/approved tickets (the duplicate warning; index tickets_party_email).
    const r = await this.driver.all(sql`SELECT t.id, t.status, t.people, t.guest_name, t.guest_email, t.answers,
        t.screenshot_key IS NOT NULL AS has_screenshot, t.created_at, t.approved_at, t.released_at, t.reject_reason, t.hold_at,
        t.used_at, t.qr_version, t.rev, t.type_id, (SELECT name FROM ticket_types WHERE id = t.type_id) AS type_name, t.price,
        CASE WHEN t.guest_email IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM tickets d WHERE d.party_id = t.party_id
          AND d.guest_email = t.guest_email AND d.id != t.id AND d.status IN ('pending', 'approved')) END AS same_email
      FROM tickets t WHERE t.party_id = ${sess.partyId} AND t.status = ${status} ${cursor}
        AND ${sessionValid(sess, MANAGERS, now)}
      ORDER BY t.created_at, t.id LIMIT ${limit}`);
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
    // The type's places too (approved people of the type + this ticket), when it has a limit.
    const typeOk = sql`(type_id IS NULL OR NOT EXISTS (SELECT 1 FROM ticket_types tq WHERE tq.id = tickets.type_id
      AND tq.quantity IS NOT NULL AND ${typeApproved(sql`tq.id`)} + tickets.people > tq.quantity))`;
    return this.bulk(sess, ids, "approved", ids.map((id) => sql`UPDATE tickets SET status = 'approved', approved_at = ${now}, approved_by = ${actor},
        rev = rev + 1, last_op = ${op}, last_action = 'approved'
      WHERE id = ${id} AND party_id = ${sess.partyId} AND status = 'pending'
        AND ${approvedPeople(sess.partyId)} + people <= ${cap} AND ${typeOk} AND ${ok}`), [], now, actor, op, null,
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
    const r = await this.driver.all<{ id: string; guest_email: string | null; guest_name: string | null; people: number; link_version: number; party_name: string }>(
      sql`SELECT t.id, t.guest_email, t.guest_name, t.people, t.link_version, p.name AS party_name FROM tickets t JOIN parties p ON p.id = t.party_id
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
        t.released_at, rl.name AS released_by, t.used_at, us.name AS scanned_by, t.qr_version, t.hold_at,
        ty.name AS type_name, t.price, t.price * t.people AS total_price
      FROM tickets t
        LEFT JOIN ticket_types ty ON ty.id = t.type_id
        LEFT JOIN staff ap ON ap.id = t.approved_by LEFT JOIN staff rj ON rj.id = t.rejected_by
        LEFT JOIN staff rl ON rl.id = t.released_by LEFT JOIN staff us ON us.id = t.used_by
      WHERE t.party_id = ${sess.partyId} AND t.id > ${after} AND ${sessionValid(sess, MANAGERS, now)}
      ORDER BY t.id LIMIT ${limit}`);
    return r.results;
  }

  /**
   * Owner decision: pending requests are cleaned up by hand only. Rejects up to
   * `limit` of the party's pending requests created before `before` (oldest
   * first), with a reason the guest sees, in ONE statement; their places are free
   * at once. Returns the tickets changed and how many such requests remain.
   */
  async rejectStale(sess: SessionRef, before: number, reason: string, limit: number, now: number, actor: string, op: string) {
    const ok = sessionValid(sess, MANAGERS, now);
    const stale = sql`party_id = ${sess.partyId} AND status = 'pending' AND created_at < ${before}`;
    const rs = await this.driver.batch([
      sql`UPDATE tickets SET status = 'rejected', reject_reason = ${reason}, rejected_at = ${now}, rejected_by = ${actor},
          rev = rev + 1, last_op = ${op}, last_action = 'rejected'
        WHERE id IN (SELECT id FROM tickets WHERE ${stale} ORDER BY created_at LIMIT ${limit}) AND ${stale} AND ${ok}`,
      audit(now, actor, "rejected", "ticket", sql`SELECT party_id, id, rev FROM tickets WHERE party_id = ${sess.partyId} AND last_op = ${op}`, reason),
      sql`SELECT id FROM tickets WHERE party_id = ${sess.partyId} AND last_op = ${op}`,
      sql`SELECT COUNT(*) AS n FROM tickets WHERE ${stale}`,
    ]);
    return {
      ids: (rs[2]!.results as { id: string }[]).map((r) => r.id),
      remaining: Number((rs[3]!.results[0] as { n: number }).n),
    };
  }
  // ------------------------------------------- staff-issued tickets, search, stats

  /**
   * A ticket issued by the owner/admin (complimentary or the door list): approved
   * at once and, when asked, released with its email in the same batch. The same
   * capacity and type-places rules as a guest request, in the insert; any active
   * type of the party may be used, staff-only ones included, whatever its sales
   * window. The id comes from the browser's op id, so a retry is the same ticket.
   */
  async issue(sess: SessionRef, a: {
    id: string; name: string; email: string | null; people: number; typeId: string | null; complimentary: boolean;
    release: boolean; mail: OutboxRow | null;
  }, now: number, actor: string, op: string): Promise<"created" | "already" | "type_unavailable" | "type_full" | "full" | "too_many_people" | "refused"> {
    const ok = sessionValid(sess, MANAGERS, now);
    const tt = sql`FROM ticket_types tt WHERE tt.id = ${a.typeId} AND tt.party_id = p.id`;
    const typeOk = a.typeId === null ? sql`1` : sql`EXISTS (SELECT 1 ${tt} AND tt.archived_at IS NULL)`;
    const placesOk = a.typeId === null ? sql`1`
      : sql`EXISTS (SELECT 1 ${tt} AND (tt.quantity IS NULL OR ${typeHeld(sql`tt.id`)} + ${a.people} <= tt.quantity))`;
    const price = a.complimentary ? sql`0` : a.typeId === null ? sql`NULL` : sql`(SELECT tt.price ${tt})`;
    const roomOk = sql`${held(sql`p.id`)} + ${a.people} <= p.capacity`;
    const peopleOk = sql`${a.people} <= p.max_people_per_ticket`;
    const rel = a.release ? now : null;
    const rs = await this.driver.batch([
      sql`INSERT INTO tickets (id, party_id, status, people, guest_name, guest_email, type_id, price, created_at,
          approved_at, approved_by, released_at, released_by, last_op, last_action)
        SELECT ${a.id}, p.id, 'approved', ${a.people}, ${a.name}, ${a.email}, ${a.typeId}, ${price}, ${now},
          ${now}, ${actor}, ${rel}, ${a.release ? actor : null}, ${op}, 'ticket_issued'
        FROM parties p
        WHERE p.id = ${sess.partyId} AND ${ok} AND ${peopleOk} AND ${roomOk} AND ${typeOk} AND ${placesOk}
          AND NOT EXISTS (SELECT 1 FROM tickets x WHERE x.id = ${a.id})`,
      audit(now, actor, "ticket_issued", "ticket", sql`SELECT party_id, id, rev FROM tickets WHERE id = ${a.id} AND last_op = ${op}`,
        a.complimentary ? "complimentary" : null),
      ...(a.mail ? [outboxInsert(a.mail, sql`EXISTS (SELECT 1 FROM tickets WHERE id = ${a.id} AND party_id = ${sess.partyId}
        AND last_op = ${op} AND last_action = 'ticket_issued' AND released_at IS NOT NULL AND guest_email = ${a.mail.toEmail})`)] : []),
      sql`SELECT (SELECT party_id FROM tickets WHERE id = ${a.id}) AS existing_party, ${ok} AS session_ok,
          CASE WHEN NOT ${peopleOk} THEN 'too_many_people' WHEN NOT ${typeOk} THEN 'type_unavailable'
            WHEN NOT ${placesOk} THEN 'type_full' WHEN NOT ${roomOk} THEN 'full' ELSE 'refused' END AS why
        FROM parties p WHERE p.id = ${sess.partyId}`,
    ]);
    if (rs[0]!.meta.changes === 1) return "created";
    const d = rs.at(-1)!.results[0] as undefined | { existing_party: string | null; session_ok: number; why: string };
    if (!d || !d.session_ok) return "refused";
    if (d.existing_party === sess.partyId) return "already";
    if (d.existing_party !== null) return "refused";
    return d.why as "type_unavailable" | "type_full" | "full" | "too_many_people" | "refused";
  }

  /**
   * Staff search (owner/admin): by ticket id, by email (starts with) or by name
   * (contains; ASCII letters ignore case). Reads the party's tickets only.
   */
  async search(sess: SessionRef, q: string, now: number, limit = 20) {
    const like = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    const where = isBase32(q, 16) ? sql`t.id = ${q}`
      : q.includes("@") ? sql`t.guest_email LIKE ${`${like.toLowerCase()}%`} ESCAPE '\\'`
        : sql`t.guest_name LIKE ${`%${like}%`} ESCAPE '\\'`;
    const r = await this.driver.all(sql`SELECT t.id, t.status, t.people, t.guest_name, t.guest_email, t.created_at, t.approved_at,
        t.released_at, t.used_at, t.hold_at, t.link_version, (SELECT name FROM ticket_types WHERE id = t.type_id) AS type_name
      FROM tickets t WHERE t.party_id = ${sess.partyId} AND ${where} AND ${sessionValid(sess, MANAGERS, now)}
      ORDER BY t.created_at DESC LIMIT ${limit}`);
    return r.results;
  }

  /**
   * The capacity indicator and check-in figures, from the party's tickets (no
   * scan rows are read: scans has no party index, and an admission is the
   * ticket's used_at/used_by). Two reads of the party's tickets.
   */
  async stats(sess: SessionRef, now: number, roles: readonly ("owner" | "admin" | "door")[]) {
    const ok = sessionValid(sess, roles, now);
    const rs = await this.driver.batch([
      sql`SELECT p.capacity, t.type_id, ty.name AS type_name, ty.quantity, ty.archived_at, ty.staff_only,
          COUNT(t.id) AS tickets,
          COALESCE(SUM(CASE WHEN t.status = 'pending' THEN t.people END), 0) AS pending,
          COALESCE(SUM(CASE WHEN t.status = 'approved' THEN t.people END), 0) AS approved,
          COALESCE(SUM(CASE WHEN t.status = 'approved' AND t.released_at IS NOT NULL THEN t.people END), 0) AS released,
          COALESCE(SUM(CASE WHEN t.used_at IS NOT NULL THEN t.people END), 0) AS admitted,
          COALESCE(SUM(CASE WHEN t.used_at IS NOT NULL THEN 1 END), 0) AS admitted_tickets
        FROM parties p LEFT JOIN tickets t ON t.party_id = p.id LEFT JOIN ticket_types ty ON ty.id = t.type_id
        WHERE p.id = ${sess.partyId} AND ${ok}
        GROUP BY t.type_id`,
      sql`SELECT t.used_at / 600000 AS slot, t.used_by, st.name AS scanner, COUNT(*) AS tickets, SUM(t.people) AS people
        FROM tickets t LEFT JOIN staff st ON st.id = t.used_by
        WHERE t.party_id = ${sess.partyId} AND t.used_at IS NOT NULL AND ${ok}
        GROUP BY slot, t.used_by ORDER BY slot`,
      sql`SELECT id, name, quantity, archived_at, staff_only FROM ticket_types WHERE party_id = ${sess.partyId} AND ${ok}`,
    ]);
    return {
      byType: rs[0]!.results as { capacity: number; type_id: string | null; type_name: string | null; quantity: number | null;
        tickets: number; pending: number; approved: number; released: number; admitted: number; admitted_tickets: number }[],
      slots: rs[1]!.results as { slot: number; used_by: string | null; scanner: string | null; tickets: number; people: number }[],
      types: rs[2]!.results as { id: string; name: string; quantity: number | null; archived_at: number | null; staff_only: number }[],
    };
  }
}
