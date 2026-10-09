// Guest details are deleted 7 days after the party (owner decision, 2026-10-09).
//
// Run once a day from the health checks (src/health/). For each party that ended
// (ends_at, or 12 hours after starts_at) more than GUEST_RETENTION.days ago:
//  - tickets: guest_name, guest_email, instagram, answers and reject_reason become NULL
//    (the ID photo's bytes go with the daily file purge, src/storage/);
//  - change log (ledger database): the same four fields become null in EVERY
//    logged copy of those tickets (event ids "ticket:<id>:<rev>", rev 1 to the
//    current one), so recovery and its verification still see the same state;
//  - audit: the rejection reasons recorded for those tickets are cleared;
//  - outbox: that party's emails lose their address, subject and text (any not
//    yet sent are cancelled).
// What stays: the ticket rows themselves (status, people, type, price, check-in
// time, the accepted Terms versions), so counts and door history still add up,
// with nobody named. One audit row per run per party records how many tickets
// were cleared. A party is marked done (guest_erasures, migration 0019) once none
// of its tickets has details left, so later runs skip it; a ticket created after
// that mark (staff can still issue one) brings the party back.
//
// Order: the ledger first, then the main database. If the main write fails after
// the ledger write, the next run does both again (both are idempotent); until
// then the ticket's ledger copy is the cleared one, which recovery treats as a
// difference and holds (the party is long over, so nothing is let in by it).
//
// No change-log entry is written for the clearing itself (it would be a copy of
// what was removed, and its rev bump is not needed: the cleared copies are equal).
// Payment screenshots follow the same 7 days (src/storage/ purgeOldScreenshots).

import type { SqlDriver } from "../db/driver";
import { inList, sql } from "../db/sql";

export const GUEST_RETENTION = {
  /** Days after the party before guest details are deleted. */
  days: 7,
  /** Tickets cleared per run (the next run continues). */
  perRun: 200,
  /** Bound values per statement (D1 allows 100). */
  chunk: 90,
};
const DAY = 86_400_000;
/** The four ticket fields that identify or describe a guest. */
export const GUEST_FIELDS = ["guest_name", "guest_email", "instagram", "answers", "reject_reason"] as const;

export interface EraseReport {
  parties: number;
  tickets: number;
  log_entries: number;
  emails: number;
  more: boolean;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function eraseGuestDetails(main: SqlDriver, ledger: SqlDriver, now: number): Promise<EraseReport> {
  const report: EraseReport = { parties: 0, tickets: 0, log_entries: 0, emails: 0, more: false };
  const cutoff = now - GUEST_RETENTION.days * DAY;
  const parties = (await main.all<{ id: string }>(sql`SELECT p.id FROM parties p
    WHERE p.starts_at IS NOT NULL AND COALESCE(p.ends_at, p.starts_at + 43200000) < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM guest_erasures e WHERE e.party_id = p.id
        AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.party_id = p.id AND t.created_at > e.done_at))
    ORDER BY p.starts_at LIMIT 20`)).results.map((r) => r.id);
  let budget = GUEST_RETENTION.perRun;
  for (const partyId of parties) {
    if (budget <= 0) { report.more = true; break; }
    const rows = (await main.all<{ id: string; rev: number }>(sql`SELECT id, rev FROM tickets
      WHERE party_id = ${partyId} AND (guest_name IS NOT NULL OR guest_email IS NOT NULL OR instagram IS NOT NULL OR answers IS NOT NULL OR reject_reason IS NOT NULL)
      LIMIT ${budget + 1}`)).results;
    const todo = rows.slice(0, budget);
    const finished = rows.length <= budget;
    if (todo.length) {
      // 1. Every logged copy, by primary key.
      const events = todo.flatMap((t) => Array.from({ length: Number(t.rev) }, (_, i) => `ticket:${t.id}:${i + 1}`));
      for (const part of chunks(events, GUEST_RETENTION.chunk)) {
        const r = await ledger.all(sql`UPDATE change_log SET state = json_set(state,
            '$.guest_name', json('null'), '$.guest_email', json('null'), '$.instagram', json('null'), '$.answers', json('null'), '$.reject_reason', json('null'))
          WHERE event_id IN (${inList(part)})
            AND (json_extract(state, '$.guest_name') IS NOT NULL OR json_extract(state, '$.guest_email') IS NOT NULL OR json_extract(state, '$.instagram') IS NOT NULL
              OR json_extract(state, '$.answers') IS NOT NULL OR json_extract(state, '$.reject_reason') IS NOT NULL)`);
        report.log_entries += r.meta.changes;
      }
      // 2. The main database, one batch.
      const writes = chunks(todo.map((t) => t.id), GUEST_RETENTION.chunk).flatMap((ids) => [
        sql`UPDATE tickets SET guest_name = NULL, guest_email = NULL, instagram = NULL, answers = NULL, reject_reason = NULL
          WHERE party_id = ${partyId} AND id IN (${inList(ids)})`,
        sql`UPDATE audit SET detail = NULL WHERE entity_type = 'ticket' AND action = 'rejected' AND party_id = ${partyId}
          AND entity_id IN (${inList(ids)}) AND detail IS NOT NULL`,
      ]);
      writes.push(sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
        VALUES (${partyId}, ${now}, NULL, 'guest_details_deleted', 'party', ${partyId}, NULL,
          ${`${todo.length} ticket${todo.length === 1 ? "" : "s"}: name, email, Instagram, answers and rejection reason deleted ${GUEST_RETENTION.days} days after the party`})`);
      await main.batch(writes);
      report.tickets += todo.length;
      budget -= todo.length;
    }
    if (finished) {
      const rs = await main.batch([
        sql`UPDATE outbox SET to_email = '', subject = '', body_text = '',
            status = CASE WHEN status IN ('awaiting_approval', 'queued') THEN 'cancelled' ELSE status END
          WHERE party_id = ${partyId} AND (to_email != '' OR body_text != '')`,
        sql`INSERT INTO guest_erasures (party_id, done_at) VALUES (${partyId}, ${now}) ON CONFLICT (party_id) DO UPDATE SET done_at = excluded.done_at`,
      ]);
      report.emails += rs[0]!.meta.changes;
      report.parties++;
    } else {
      report.more = true;
    }
  }
  return report;
}
