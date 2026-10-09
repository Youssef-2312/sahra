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

import { flyerListJson } from "../party/flyers";
import type { SqlDriver } from "../db/driver";
import { audit, sessionValid, type SessionRef } from "../db/index";
import { inList, join, sql, type Sql } from "../db/sql";
import { isBase32 } from "../lib/crypto";
import { outboxInsert, type OutboxRow } from "../outbox";
import { hasPublicTypes, onSale, peopleOk, typeApproved, typeHeld } from "./types";

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
  /** The organiser's support number (migrations/0023); requests stay closed while it is NULL. */
  support_phone: string | null;
  registration_closes_at: number | null;
  max_tickets_per_email: number | null;
  /** Pending + approved tickets of the party for the given email (0 without one). */
  email_tickets: number;
  /** 1 when the party has public ticket types: a request must then name one. */
  has_types: number;
  payment_instructions: string | null;
  /** The party's entry rules now (what a guest accepts; src/guests/policy.ts). */
  rules: string | null;
  cancellation_policy: string | null;
  /** For the chosen type (if any): 1 when on sale to guests now, and its places left (NULL = no limit of its own). */
  type_on_sale: number | null;
  type_left: number | null;
  /** People one ticket admits: the chosen type's own limits, else 1 up to the party's (migrations/0021). */
  min_people: number;
  max_people: number;
}

/** Why a sign-up was not stored (the same rules as the insert, read in the same batch). */
export type SignupRefusal = "registration_not_open" | "registration_closed" | "email_limit" | "type_required" | "type_unavailable"
  | "type_full" | "full" | "terms_changed" | "people_out_of_range" | "refused";

/** The registration rules of a party row aliased `p`, at `now`, for one email (all inside SQL). */
function registrationRules(now: number, email: string, count = 1) {
  const emailCount = sql`(SELECT COUNT(*) FROM tickets e WHERE e.party_id = p.id AND e.guest_email = ${email} AND e.status IN ('pending', 'approved'))`;
  return {
    // No requests until the organiser has set a support number (brainstorm idea 16, migrations/0023).
    opened: sql`(p.support_phone IS NOT NULL AND (p.registration_opens_at IS NULL OR p.registration_opens_at <= ${now}))`,
    notClosed: sql`(p.registration_closes_at IS NULL OR p.registration_closes_at > ${now})`,
    // Every ticket of the order counts (an order of 3 needs 3 free).
    emailOk: sql`(p.max_tickets_per_email IS NULL OR ${emailCount} + ${count} <= p.max_tickets_per_email)`,
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
  type_entry_from: number | null;
  price: number | null;
}

export type BulkResult = Record<string, "done" | "already" | "refused">;

export const MAX_BULK = 20;

export class GuestDb {
  constructor(readonly driver: SqlDriver) {}

  // ------------------------------------------------------------ guests

  /** The tickets of the order led by `leadId` (just that ticket when it is a single one), oldest first. */
  async orderTickets(partyId: string, leadId: string): Promise<{ id: string; guest_name: string | null }[]> {
    const r = await this.driver.all<{ id: string; guest_name: string | null }>(sql`SELECT id, guest_name FROM tickets
      WHERE party_id = ${partyId} AND (id = ${leadId} OR order_id = ${leadId}) ORDER BY id = ${leadId} DESC, created_at, id`);
    return r.results;
  }

  /** One read before sign-up: the party, its form, places held, and whether this sign-up already exists. */
  async signupParty(partyId: string, ticketId: string, o: { email?: string; typeId?: string | null; now?: number } = {}): Promise<SignupParty | null> {
    const email = o.email ?? null;
    const typeId = o.typeId ?? null;
    const now = o.now ?? 0;
    const tt = sql`FROM ticket_types tt WHERE tt.id = ${typeId} AND tt.party_id = p.id`;
    const r = await this.driver.all<SignupParty>(sql`SELECT p.id, p.name, p.capacity, p.max_people_per_ticket, p.guest_form,
        ${held(sql`p.id`)} AS held, (SELECT party_id FROM tickets WHERE id = ${ticketId}) AS existing_party,
        p.registration_opens_at, p.registration_closes_at, p.max_tickets_per_email, p.payment_instructions, p.rules, p.cancellation_policy, p.support_phone,
        ${email === null ? sql`0` : sql`(SELECT COUNT(*) FROM tickets e WHERE e.party_id = p.id AND e.guest_email = ${email} AND e.status IN ('pending', 'approved'))`} AS email_tickets,
        ${hasPublicTypes(sql`p.id`)} AS has_types,
        ${typeId === null ? sql`NULL` : sql`EXISTS (SELECT 1 ${tt} AND ${onSale(now)})`} AS type_on_sale,
        ${typeId === null ? sql`NULL` : sql`(SELECT tt.quantity - ${typeHeld(sql`tt.id`)} ${tt})`} AS type_left,
        ${typeId === null ? sql`1` : sql`COALESCE((SELECT tt.min_people ${tt}), 1)`} AS min_people,
        ${typeId === null ? sql`p.max_people_per_ticket` : sql`COALESCE((SELECT tt.max_people ${tt}), p.max_people_per_ticket)`} AS max_people
      FROM parties p WHERE p.id = ${partyId}`);
    return r.results[0] ?? null;
  }

  /**
   * The sign-up batch: insert the pending ticket(s) only if the party has room for
   * their people (same statement), audit them, and read back. A retry with the same
   * ticket id inserts nothing and is recognized by the read-back. The accepted
   * versions are stored in the same rows, and only while the party's rules are
   * still the texts the guest accepted (entry rules and cancellation policy; NULL = none).
   *
   * An order (`more`: the other tickets' ids and names, migrations/0022) is one
   * INSERT of every ticket, all or none, with the whole order counted against the
   * capacity, the type's places and the tickets-per-email limit. The payment proof,
   * ID photo, answers and handle stay on the first ticket.
   */
  async signup(a: {
    id: string; partyId: string; people: number; name: string; email: string; answers: string | null;
    screenshotKey: string | null; idPhotoKey?: string | null; instagram?: string | null; typeId: string | null; now: number; op: string;
    rules: string | null; cancellation: string | null; accepted: { terms: string; rules: string | null; privacy: string };
    more?: { id: string; name: string }[];
  }): Promise<"created" | "already" | SignupRefusal> {
    const more = a.more ?? [];
    const count = 1 + more.length;
    const reg = registrationRules(a.now, a.email, count);
    const ty = typeRules(a.typeId, a.people * count, a.now);
    const roomOk = sql`${held(sql`p.id`)} + ${a.people * count} <= p.capacity`;
    const rulesOk = sql`(p.rules IS ${a.rules} AND p.cancellation_policy IS ${a.cancellation})`;
    const orderId = count > 1 ? a.id : null;
    const rows = join([sql`(0, ${a.id}, ${a.name})`, ...more.map((m, i) => sql`(${i + 1}, ${m.id}, ${m.name})`)], ", ");
    const ids = [a.id, ...more.map((m) => m.id)];
    const rs = await this.driver.batch([
      sql`WITH o(i, id, nm) AS (VALUES ${rows})
        INSERT INTO tickets (id, party_id, status, people, guest_name, guest_email, answers, screenshot_key, id_photo_key, instagram, type_id, price,
          order_id, terms_version, rules_version, privacy_version, terms_accepted_at, created_at, last_op, last_action)
        SELECT o.id, p.id, 'pending', ${a.people}, o.nm, ${a.email},
          CASE WHEN o.i = 0 THEN ${a.answers} END, CASE WHEN o.i = 0 THEN ${a.screenshotKey} END,
          CASE WHEN o.i = 0 THEN ${a.idPhotoKey ?? null} END, CASE WHEN o.i = 0 THEN ${a.instagram ?? null} END, ${a.typeId}, ${ty.price},
          ${orderId}, ${a.accepted.terms}, ${a.accepted.rules}, ${a.accepted.privacy}, ${a.now}, ${a.now}, ${a.op}, 'ticket_requested'
        FROM o, parties p
        WHERE p.id = ${a.partyId} AND ${peopleOk(a.typeId, a.people)} AND ${roomOk} AND ${rulesOk}
          AND ${reg.opened} AND ${reg.notClosed} AND ${reg.emailOk} AND ${ty.chosenOk} AND ${ty.placesOk}
          AND NOT EXISTS (SELECT 1 FROM tickets x WHERE x.id IN (${inList(ids)}))
        ORDER BY o.i`,
      audit(a.now, null, "ticket_requested", "ticket", sql`SELECT party_id, id, rev FROM tickets WHERE id IN (${inList(ids)}) AND last_op = ${a.op}`),
      // Why nothing was stored, from the same rules on the same state.
      sql`SELECT (SELECT party_id FROM tickets WHERE id = ${a.id}) AS existing_party,
          CASE
            WHEN NOT ${rulesOk} THEN 'terms_changed'
            WHEN NOT ${reg.opened} THEN 'registration_not_open'
            WHEN NOT ${reg.notClosed} THEN 'registration_closed'
            WHEN NOT ${reg.emailOk} THEN 'email_limit'
            WHEN NOT ${ty.chosenOk} THEN ${a.typeId === null ? "type_required" : "type_unavailable"}
            WHEN NOT ${peopleOk(a.typeId, a.people)} THEN 'people_out_of_range'
            WHEN NOT ${ty.placesOk} THEN 'type_full'
            WHEN NOT ${roomOk} THEN 'full'
            ELSE 'refused'
          END AS why
        FROM parties p WHERE p.id = ${a.partyId}`,
    ]);
    if (rs[0]!.meta.changes === count) return "created";
    const row = rs[2]!.results[0] as { existing_party: string | null; why: SignupRefusal } | undefined;
    if (row?.existing_party === a.partyId) return "already";
    if (!row || row.existing_party !== null) return "refused";
    return row.why;
  }

  /**
   * The home page's list: parties with a start time, not switched off, and not
   * over (their end, or 12 hours after the start). Public data only (name, times,
   * places left, the lowest public price and how many prices, the pictures); never the place.
   */
  async listedParties(now: number) {
    const r = await this.driver.all<{ id: string; name: string; starts_at: number; ends_at: number | null; time_zone: string | null;
      capacity: number; held: number; registration_opens_at: number | null; registration_closes_at: number | null; support_phone: string | null; prices: string; flyers: string }>(
      // One pass over the public types gives both the lowest price and how many different prices there are
      // (the card says "EGP 350" for one price, "From EGP 350" for several).
      sql`SELECT p.id, p.name, p.starts_at, p.ends_at, p.time_zone, p.capacity, ${held(sql`p.id`)} AS held,
          p.registration_opens_at, p.registration_closes_at, p.support_phone,
          (SELECT json_array(MIN(tt.price), COUNT(DISTINCT tt.price)) FROM ticket_types tt
            WHERE tt.party_id = p.id AND tt.archived_at IS NULL AND tt.staff_only = 0) AS prices,
          ${flyerListJson(sql`p.id`)} AS flyers
        FROM parties p
        WHERE p.disabled_at IS NULL AND p.starts_at IS NOT NULL AND COALESCE(p.ends_at, p.starts_at + 43200000) > ${now}
        ORDER BY p.starts_at, p.id LIMIT 50`);
    return r.results.map(({ prices, flyers, ...p }) => {
      const [low, count] = JSON.parse(prices) as [number | null, number];
      return { ...p, from_price: low, price_count: count, flyers: JSON.parse(flyers) as { id: string; rev: number }[] };
    });
  }

  /** Several tickets named by verified links (the home page's remembered tickets), with their party's name. */
  async ticketsForLinks(ids: string[]) {
    if (!ids.length) return [];
    const r = await this.driver.all<{ id: string; party_id: string; status: string; released_at: number | null; hold_at: number | null;
      used_at: number | null; link_version: number; party_name: string; starts_at: number | null; time_zone: string | null }>(
      sql`SELECT t.id, t.party_id, t.status, t.released_at, t.hold_at, t.used_at, t.link_version, p.name AS party_name, p.starts_at, p.time_zone
        FROM tickets t JOIN parties p ON p.id = t.party_id WHERE t.id IN (${inList(ids)})`);
    return r.results;
  }

  /** The ticket named by a verified link, with its party's name. */
  async guestTicket(partyId: string, ticketId: string): Promise<GuestTicket | null> {
    const r = await this.driver.all<GuestTicket>(sql`SELECT t.id, t.party_id, p.name AS party_name, t.status, t.people, t.guest_name,
        t.qr_version, t.link_version, t.released_at, t.hold_at, t.used_at, t.reject_reason,
        (SELECT name FROM ticket_types WHERE id = t.type_id) AS type_name,
        (SELECT entry_from FROM ticket_types WHERE id = t.type_id) AS type_entry_from, t.price
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
   * "Find my tickets": this address's live tickets across parties that are not
   * over (or ended less than a day ago), soonest party first, at most 20. Reads
   * the parties table (small) and each party's (party_id, guest_email) index.
   * Cancelled tickets and disabled or reserved parties are left out.
   */
  async ticketsAcrossParties(email: string, now: number) {
    const r = await this.driver.all<{ id: string; link_version: number; party_id: string; party_name: string; starts_at: number | null; time_zone: string | null }>(
      sql`SELECT t.id, t.link_version, t.party_id, p.name AS party_name, p.starts_at, p.time_zone
        FROM tickets t JOIN parties p ON p.id = t.party_id
        WHERE t.party_id IN (SELECT id FROM parties WHERE disabled_at IS NULL AND substr(id, 1, 1) != '_'
            AND (starts_at IS NULL OR COALESCE(ends_at, starts_at + 43200000) > ${now - 86_400_000}))
          AND t.guest_email = ${email} AND t.status IN ('pending', 'approved', 'rejected')
        ORDER BY p.starts_at IS NULL, p.starts_at, t.created_at LIMIT 20`,
    );
    return r.results;
  }

  /** Adds a "Find my tickets" email unless one with the same id exists (one per address per window). */
  async addFindEmail(row: OutboxRow): Promise<boolean> {
    const r = await this.driver.all(outboxInsert(row, sql`NOT EXISTS (SELECT 1 FROM outbox WHERE id = ${row.id})`));
    return r.meta.changes === 1;
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
        t.screenshot_key IS NOT NULL AS has_screenshot, t.id_photo_key IS NOT NULL AS has_id_photo, t.instagram, t.order_id, t.created_at, t.approved_at, t.released_at, t.reject_reason, t.hold_at,
        t.used_at, t.qr_version, t.rev, t.type_id, (SELECT name FROM ticket_types WHERE id = t.type_id) AS type_name, t.price,
        CASE WHEN t.guest_email IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM tickets d WHERE d.party_id = t.party_id
          AND d.guest_email = t.guest_email AND d.id != t.id AND d.status IN ('pending', 'approved')) END AS same_email
      FROM tickets t WHERE t.party_id = ${sess.partyId} AND t.status = ${status} ${cursor}
        AND ${sessionValid(sess, MANAGERS, now)}
      ORDER BY t.created_at, t.id LIMIT ${limit}`);
    return r.results;
  }

  /** The ID photo key of one of the party's tickets (owner/admin only; checked in the query). */
  async idPhotoKey(sess: SessionRef, id: string, now: number): Promise<string | null> {
    const r = await this.driver.all<{ id_photo_key: string | null }>(sql`SELECT id_photo_key FROM tickets
      WHERE id = ${id} AND party_id = ${sess.partyId} AND ${sessionValid(sess, MANAGERS, now)}`);
    return r.results[0]?.id_photo_key ?? null;
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
    const r = await this.driver.all(sql`SELECT t.id, t.status, t.people, t.guest_name, t.guest_email, t.instagram, t.answers, t.created_at,
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
    const peopleFit = peopleOk(a.typeId, a.people);
    const rel = a.release ? now : null;
    const rs = await this.driver.batch([
      sql`INSERT INTO tickets (id, party_id, status, people, guest_name, guest_email, type_id, price, created_at,
          approved_at, approved_by, released_at, released_by, last_op, last_action)
        SELECT ${a.id}, p.id, 'approved', ${a.people}, ${a.name}, ${a.email}, ${a.typeId}, ${price}, ${now},
          ${now}, ${actor}, ${rel}, ${a.release ? actor : null}, ${op}, 'ticket_issued'
        FROM parties p
        WHERE p.id = ${sess.partyId} AND ${ok} AND ${peopleFit} AND ${roomOk} AND ${typeOk} AND ${placesOk}
          AND NOT EXISTS (SELECT 1 FROM tickets x WHERE x.id = ${a.id})`,
      audit(now, actor, "ticket_issued", "ticket", sql`SELECT party_id, id, rev FROM tickets WHERE id = ${a.id} AND last_op = ${op}`,
        a.complimentary ? "complimentary" : null),
      ...(a.mail ? [outboxInsert(a.mail, sql`EXISTS (SELECT 1 FROM tickets WHERE id = ${a.id} AND party_id = ${sess.partyId}
        AND last_op = ${op} AND last_action = 'ticket_issued' AND released_at IS NOT NULL AND guest_email = ${a.mail.toEmail})`)] : []),
      sql`SELECT (SELECT party_id FROM tickets WHERE id = ${a.id}) AS existing_party, ${ok} AS session_ok,
          CASE WHEN NOT ${peopleFit} THEN 'too_many_people' WHEN NOT ${typeOk} THEN 'type_unavailable'
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
    // A request reference ("SAH-K7Q9XM", the ticket id's first 6 characters; it identifies, it never opens a ticket).
    const ref = /^SAH-?([0-9A-Z]{6})$/i.exec(q);
    const where = ref ? sql`substr(t.id, 1, 6) = ${ref[1]!.toUpperCase()}` : isBase32(q, 16) ? sql`t.id = ${q}`
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
          COALESCE(SUM(CASE WHEN t.status = 'pending' THEN 1 END), 0) AS pending_tickets,
          COALESCE(SUM(CASE WHEN t.status = 'approved' THEN t.people END), 0) AS approved,
          COALESCE(SUM(CASE WHEN t.status = 'approved' AND t.released_at IS NOT NULL THEN t.people END), 0) AS released,
          COALESCE(SUM(CASE WHEN t.used_at IS NOT NULL THEN t.people END), 0) AS admitted,
          COALESCE(SUM(CASE WHEN t.used_at IS NOT NULL THEN 1 END), 0) AS admitted_tickets,
          COALESCE(SUM(CASE WHEN t.status = 'approved' THEN COALESCE(t.price, 0) * t.people END), 0) AS money_approved,
          COALESCE(SUM(CASE WHEN t.status = 'pending' THEN COALESCE(t.price, 0) * t.people END), 0) AS money_pending
        FROM parties p LEFT JOIN tickets t ON t.party_id = p.id LEFT JOIN ticket_types ty ON ty.id = t.type_id
        WHERE p.id = ${sess.partyId} AND ${ok}
        GROUP BY t.type_id`,
      sql`SELECT t.used_at / 900000 AS slot, t.used_by, st.name AS scanner, COUNT(*) AS tickets, SUM(t.people) AS people
        FROM tickets t LEFT JOIN staff st ON st.id = t.used_by
        WHERE t.party_id = ${sess.partyId} AND t.used_at IS NOT NULL AND ${ok}
        GROUP BY slot, t.used_by ORDER BY slot`,
      sql`SELECT id, name, quantity, archived_at, staff_only FROM ticket_types WHERE party_id = ${sess.partyId} AND ${ok}`,
      // Requests per hour over the last 30 days (the page groups them into the party's own days).
      sql`SELECT t.created_at / 3600000 AS hour, COUNT(*) AS requests, SUM(t.people) AS people
        FROM tickets t WHERE t.party_id = ${sess.partyId} AND t.created_at > ${now - 30 * 86_400_000} AND ${ok}
        GROUP BY hour ORDER BY hour`,
    ]);
    return {
      byType: rs[0]!.results as { capacity: number; type_id: string | null; type_name: string | null; quantity: number | null;
        tickets: number; pending: number; pending_tickets: number; approved: number; released: number; admitted: number; admitted_tickets: number;
        money_approved: number; money_pending: number }[],
      slots: rs[1]!.results as { slot: number; used_by: string | null; scanner: string | null; tickets: number; people: number }[],
      types: rs[2]!.results as { id: string; name: string; quantity: number | null; archived_at: number | null; staff_only: number }[],
      hours: rs[3]!.results as { hour: number; requests: number; people: number }[],
    };
  }
}
