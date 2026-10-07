// Tickets, scans and admission state. Like src/db/index.ts, every rule that
// decides whether a change happens is inside the statement that makes it,
// including "is this session still valid" and "is the party open".

import type { SqlDriver } from "./driver";
import { audit, sessionValid, type Role, type SessionRef } from "./index";
import { sql, type Sql } from "./sql";

export type ScanOutcome = "admitted" | "already_used" | "not_approved" | "not_released" | "old_version" | "unknown_ticket" | "paused";

export interface TicketRow {
  id: string;
  party_id: string;
  qr_version: number;
  status: string;
  people: number;
  guest_name: string | null;
  used_scan_id: string | null;
  used_at: number | null;
  used_by: string | null;
  released_at: number | null;
  rev: number;
  [k: string]: unknown;
}

export interface RedeemResult {
  /** The scan row for this scan id (null: no row, i.e. the session was not valid for this party). */
  scan: null | {
    party_id: string;
    session_hash: string;
    ticket_id: string;
    qr_version: number;
    qr_fingerprint: string;
    pause_number: number;
    outcome: ScanOutcome;
    ticket_rev: number | null;
    created_at: number;
  };
  /** The ticket named by the scan row, as it is now. */
  ticket: TicketRow | null;
  usedByName: string | null;
  /** Session valid right now for this party (any scanning role). */
  sessionOk: boolean;
  /** Party of the presented session if it exists and is otherwise valid (to explain a wrong-party code). */
  sessionParty: string | null;
}

const SCAN_ROLES: readonly Role[] = ["door", "admin", "owner"];

export class TicketDb {
  constructor(readonly driver: SqlDriver) {}

  /**
   * The redemption batch (section 7.3), in three statements:
   *  1. mark the ticket used ONLY IF it is this party's ticket at the current
   *     qr_version, approved, released, not yet used; no scan row with this scan
   *     id exists yet; the party is open in this database with the same
   *     pause_number as the control object; and the session is valid right now;
   *  2. insert the scan row with its FINAL outcome, computed from the ticket's state
   *     after statement 1 (on a scan id conflict, nothing is inserted);
   *  3. read back the scan row, the ticket and the session's validity.
   * Admitted = 2 rows written; denied = 1; retry of a stored scan = 0.
   */
  async redeem(a: {
    scanId: string; partyId: string; sessionHash: string; ticketId: string; qrVersion: number;
    fingerprint: string; pauseNumber: number; now: number; op: string;
  }): Promise<RedeemResult> {
    const sess: SessionRef = { hash: a.sessionHash, partyId: a.partyId };
    const ok = sessionValid(sess, SCAN_ROLES, a.now);
    const partyOpen = sql`EXISTS (SELECT 1 FROM parties WHERE id = ${a.partyId} AND admission_state = 'open' AND pause_number = ${a.pauseNumber})`;
    const rs = await this.driver.batch([
      sql`UPDATE tickets SET used_scan_id = ${a.scanId}, used_at = ${a.now},
          used_by = (SELECT staff_id FROM sessions WHERE id_hash = ${a.sessionHash}),
          rev = rev + 1, last_op = ${a.op}, last_action = 'admitted'
        WHERE id = ${a.ticketId} AND party_id = ${a.partyId} AND qr_version = ${a.qrVersion}
          AND status = 'approved' AND released_at IS NOT NULL AND used_scan_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM scans WHERE scan_id = ${a.scanId})
          AND ${partyOpen} AND ${ok}`,
      sql`INSERT INTO scans (scan_id, party_id, session_hash, staff_id, ticket_id, qr_version, qr_fingerprint,
            pause_number, created_at, outcome, ticket_rev)
        SELECT ${a.scanId}, ${a.partyId}, ${a.sessionHash}, s.staff_id, ${a.ticketId}, ${a.qrVersion}, ${a.fingerprint},
          ${a.pauseNumber}, ${a.now},
          CASE
            WHEN t.used_scan_id = ${a.scanId} THEN 'admitted'
            WHEN t.id IS NULL THEN 'unknown_ticket'
            WHEN t.qr_version != ${a.qrVersion} THEN 'old_version'
            WHEN t.used_scan_id IS NOT NULL THEN 'already_used'
            WHEN t.status != 'approved' THEN 'not_approved'
            WHEN t.released_at IS NULL THEN 'not_released'
            ELSE 'paused'
          END,
          t.rev
        FROM sessions s LEFT JOIN tickets t ON t.id = ${a.ticketId} AND t.party_id = ${a.partyId}
        WHERE s.id_hash = ${a.sessionHash} AND ${ok}
        ON CONFLICT (scan_id) DO NOTHING`,
      sql`SELECT sc.party_id, sc.session_hash, sc.ticket_id, sc.qr_version, sc.qr_fingerprint, sc.pause_number,
          sc.outcome, sc.ticket_rev, sc.created_at,
          ${ok} AS session_ok,
          (SELECT s.party_id FROM sessions s JOIN staff st ON st.id = s.staff_id
            WHERE s.id_hash = ${a.sessionHash} AND s.revoked_at IS NULL AND s.expires_at > ${a.now}
              AND st.disabled_at IS NULL AND st.role = s.role) AS session_party
        FROM (SELECT 1) LEFT JOIN scans sc ON sc.scan_id = ${a.scanId}`,
      sql`SELECT t.*, (SELECT name FROM staff WHERE id = t.used_by) AS used_by_name
        FROM tickets t WHERE t.id = (SELECT ticket_id FROM scans WHERE scan_id = ${a.scanId})`,
    ]);
    const r = rs[2]!.results[0] as Record<string, unknown>;
    const t = (rs[3]!.results[0] as (TicketRow & { used_by_name: string | null }) | undefined) ?? null;
    let usedByName: string | null = null;
    let ticket: TicketRow | null = null;
    if (t) {
      const { used_by_name, ...rest } = t;
      usedByName = used_by_name;
      ticket = rest as TicketRow;
    }
    return {
      scan: r.outcome == null ? null : {
        party_id: String(r.party_id),
        session_hash: String(r.session_hash),
        ticket_id: String(r.ticket_id),
        qr_version: Number(r.qr_version),
        qr_fingerprint: String(r.qr_fingerprint),
        pause_number: Number(r.pause_number),
        outcome: r.outcome as ScanOutcome,
        ticket_rev: r.ticket_rev == null ? null : Number(r.ticket_rev),
        created_at: Number(r.created_at),
      },
      ticket,
      usedByName,
      sessionOk: Number(r.session_ok) === 1,
      sessionParty: r.session_party == null ? null : String(r.session_party),
    };
  }

  // ------------------------------------------------------------- tickets

  /** Creates a ticket. Used by tests and the staging-only test endpoint today; guest sign-up in Phase 4. */
  async createTicket(sess: SessionRef | null, a: {
    id: string; partyId: string; people: number; guestName: string | null; status: "pending" | "approved";
    release: boolean; now: number; actor: string | null; op: string;
  }): Promise<boolean> {
    const guard = sess ? sessionValid(sess, SCAN_ROLES, a.now) : sql`1`;
    const rs = await this.driver.batch([
      sql`INSERT INTO tickets (id, party_id, status, people, guest_name, created_at, approved_at, approved_by,
            released_at, released_by, last_op, last_action)
        SELECT ${a.id}, ${a.partyId}, ${a.status}, ${a.people}, ${a.guestName}, ${a.now},
          ${a.status === "approved" ? a.now : null}, ${a.status === "approved" ? a.actor : null},
          ${a.release ? a.now : null}, ${a.release ? a.actor : null}, ${a.op}, 'ticket_created'
        WHERE ${guard} AND EXISTS (SELECT 1 FROM parties WHERE id = ${a.partyId})`,
      audit(a.now, a.actor, "ticket_created", "ticket", sql`SELECT party_id, id, rev FROM tickets WHERE id = ${a.id} AND last_op = ${a.op}`),
    ]);
    return rs[0]!.meta.changes === 1;
  }

  /**
   * One guarded ticket change. `set` and `where` are fixed SQL fragments chosen by
   * the caller (code, not input); every change bumps rev, records last_op and
   * writes an audit row in the same batch.
   */
  private async change(sess: SessionRef, roles: readonly Role[], ticketId: string, action: string,
    set: Sql, where: Sql, now: number, actor: string, op: string, detail: string | null = null) {
    const ok = sessionValid(sess, roles, now);
    const rs = await this.driver.batch([
      sql`UPDATE tickets SET ${set}, rev = rev + 1, last_op = ${op}, last_action = ${action}
        WHERE id = ${ticketId} AND party_id = ${sess.partyId} AND ${where} AND ${ok}`,
      audit(now, actor, action, "ticket", sql`SELECT party_id, id, rev FROM tickets WHERE id = ${ticketId} AND last_op = ${op}`, detail),
    ]);
    return rs[0]!.meta.changes === 1;
  }

  approve(sess: SessionRef, id: string, now: number, actor: string, op: string) {
    return this.change(sess, ["owner", "admin"], id, "approved",
      sql`status = 'approved', approved_at = ${now}, approved_by = ${actor}`, sql`status = 'pending'`, now, actor, op);
  }

  reject(sess: SessionRef, id: string, now: number, actor: string, op: string) {
    return this.change(sess, ["owner", "admin"], id, "rejected", sql`status = 'rejected'`, sql`status = 'pending'`, now, actor, op);
  }

  /** "Send QR": separate from approval; only approved tickets. */
  release(sess: SessionRef, id: string, now: number, actor: string, op: string) {
    return this.change(sess, ["owner", "admin"], id, "released",
      sql`released_at = ${now}, released_by = ${actor}`, sql`status = 'approved' AND released_at IS NULL`, now, actor, op);
  }

  /** Cancel: the ticket can never be admitted (status leaves 'approved'). Not for a ticket already used. */
  cancel(sess: SessionRef, id: string, now: number, actor: string, op: string) {
    return this.change(sess, ["owner", "admin"], id, "cancelled",
      sql`status = 'cancelled'`, sql`status IN ('pending', 'approved') AND used_scan_id IS NULL`, now, actor, op);
  }

  /** Reissue: bumps qr_version, so every older QR code for this ticket stops working. */
  reissue(sess: SessionRef, id: string, now: number, actor: string, op: string) {
    return this.change(sess, ["owner", "admin"], id, "reissued",
      sql`qr_version = qr_version + 1`, sql`status = 'approved' AND used_scan_id IS NULL`, now, actor, op);
  }

  /** Privileged admission reset: owner only, reason required, logged. Makes a used ticket usable again. */
  resetAdmission(sess: SessionRef, id: string, reason: string, now: number, actor: string, op: string) {
    return this.change(sess, ["owner"], id, "admission_reset",
      sql`used_scan_id = NULL, used_at = NULL, used_by = NULL`, sql`used_scan_id IS NOT NULL`, now, actor, op, reason);
  }

  async getTicket(partyId: string, id: string): Promise<TicketRow | null> {
    const r = await this.driver.all<TicketRow>(sql`SELECT * FROM tickets WHERE id = ${id} AND party_id = ${partyId}`);
    return r.results[0] ?? null;
  }

  // ----------------------------------------------------- admission state

  async partyAdmission(partyId: string) {
    const r = await this.driver.all<{ admission_state: string; pause_number: number; rev: number }>(
      sql`SELECT admission_state, pause_number, rev FROM parties WHERE id = ${partyId}`,
    );
    return r.results[0] ?? null;
  }

  /**
   * Sets this database's admission state and pause_number (owner/admin). Opening
   * copies the control object's pause_number (section 8.3 step 6); pausing records
   * the new pause_number already set in the control object.
   */
  async setAdmission(sess: SessionRef, state: "open" | "paused", pauseNumber: number, now: number, actor: string, op: string) {
    const ok = sessionValid(sess, ["owner", "admin"], now);
    const rs = await this.driver.batch([
      sql`UPDATE parties SET admission_state = ${state}, pause_number = ${pauseNumber}, rev = rev + 1,
          last_op = ${op}, last_action = ${state === "open" ? "admission_opened" : "admission_paused"}
        WHERE id = ${sess.partyId} AND (admission_state != ${state} OR pause_number != ${pauseNumber}) AND ${ok}`,
      audit(now, actor, state === "open" ? "admission_opened" : "admission_paused", "party",
        sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${sess.partyId} AND last_op = ${op}`, String(pauseNumber)),
      sql`SELECT admission_state, pause_number FROM parties WHERE id = ${sess.partyId} AND ${ok}`,
    ]);
    const row = rs[2]!.results[0] as { admission_state: string; pause_number: number } | undefined;
    return !!row && row.admission_state === state && row.pause_number === pauseNumber;
  }
}
