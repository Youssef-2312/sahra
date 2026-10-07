// TEMPORARY (Checkpoint A): stand-in for the Phase 2 redemption batch, shaped like
// section 7.3 so its CPU time and rows read/written are representative.

import type { SqlDriver } from "./driver";
import { sessionValid, type SessionRef } from "./index";
import { sql } from "./sql";

export class ProtoDb {
  constructor(private readonly driver: SqlDriver) {}

  async createTicket(sess: SessionRef, id: string, now: number) {
    const r = await this.driver.all(sql`INSERT INTO proto_tickets (id, party_id, released_at)
      SELECT ${id}, ${sess.partyId}, ${now} WHERE ${sessionValid(sess, ["owner", "admin", "door"], now)}`);
    return r.meta.changes === 1;
  }

  async redeem(a: {
    sess: SessionRef; staffId: string; scanId: string; ticketId: string; qrVersion: number;
    fingerprint: string; pauseNumber: number; now: number;
  }) {
    const ok = sessionValid(a.sess, ["owner", "admin", "door"], a.now);
    const p = a.sess.partyId;
    const scanMatches = sql`EXISTS (SELECT 1 FROM proto_scans sc WHERE sc.scan_id = ${a.scanId} AND sc.party_id = ${p}
      AND sc.session_hash = ${a.sess.hash} AND sc.ticket_id = ${a.ticketId} AND sc.qr_version = ${a.qrVersion}
      AND sc.qr_fingerprint = ${a.fingerprint} AND sc.pause_number = ${a.pauseNumber} AND sc.outcome = 'pending')`;
    const rs = await this.driver.batch([
      sql`INSERT INTO proto_scans (scan_id, party_id, session_hash, staff_id, ticket_id, qr_version, qr_fingerprint, pause_number, created_at, outcome)
        SELECT ${a.scanId}, ${p}, ${a.sess.hash}, ${a.staffId}, ${a.ticketId}, ${a.qrVersion}, ${a.fingerprint}, ${a.pauseNumber}, ${a.now}, 'pending'
        WHERE ${ok} ON CONFLICT (scan_id) DO NOTHING`,
      sql`UPDATE proto_tickets SET used_scan_id = ${a.scanId}, used_at = ${a.now}, used_by = ${a.staffId}, rev = rev + 1
        WHERE id = ${a.ticketId} AND party_id = ${p} AND qr_version = ${a.qrVersion} AND status = 'approved'
          AND released_at IS NOT NULL AND used_scan_id IS NULL AND ${scanMatches} AND ${ok}`,
      sql`UPDATE proto_scans SET outcome = CASE
          WHEN EXISTS (SELECT 1 FROM proto_tickets t WHERE t.id = ${a.ticketId} AND t.used_scan_id = ${a.scanId}) THEN 'admitted'
          WHEN NOT EXISTS (SELECT 1 FROM proto_tickets t WHERE t.id = ${a.ticketId} AND t.party_id = ${p}) THEN 'unknown_ticket'
          WHEN EXISTS (SELECT 1 FROM proto_tickets t WHERE t.id = ${a.ticketId} AND t.qr_version != ${a.qrVersion}) THEN 'old_version'
          WHEN EXISTS (SELECT 1 FROM proto_tickets t WHERE t.id = ${a.ticketId} AND t.used_scan_id IS NOT NULL) THEN 'already_used'
          ELSE 'not_approved' END
        WHERE scan_id = ${a.scanId} AND outcome = 'pending' AND party_id = ${p} AND session_hash = ${a.sess.hash}
          AND ticket_id = ${a.ticketId} AND qr_fingerprint = ${a.fingerprint}`,
      sql`SELECT sc.party_id, sc.session_hash, sc.ticket_id, sc.qr_fingerprint, sc.outcome, t.rev, t.used_at, t.used_by
        FROM proto_scans sc LEFT JOIN proto_tickets t ON t.id = sc.ticket_id WHERE sc.scan_id = ${a.scanId}`,
    ]);
    const row = rs[3]!.results[0] as undefined | {
      party_id: string; session_hash: string; ticket_id: string; qr_fingerprint: string; outcome: string; rev: number;
    };
    const written = rs.reduce((n, r) => n + r.meta.rows_written, 0);
    return { row: row ?? null, rows_written: written };
  }
}
