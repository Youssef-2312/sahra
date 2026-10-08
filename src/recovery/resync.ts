// After a controlled recovery: outbox rows created after the restore point were
// lost with it, but the releases themselves came back through the change log. So
// every ticket released after the restore point that has no "your ticket" email
// gets one again (the same text and link as a normal release). A guest who had
// already received it gets it twice, which is harmless: it is the same ticket
// link. Bounded per run; resumes from a cursor; clears itself when done.

import type { SqlDriver } from "../db/driver";
import { sql, join } from "../db/sql";
import { releasedEmail } from "../guests/emails";
import { signLink } from "../guests/link";
import { outboxInsert } from "../outbox";

const BATCH = 50;

export async function resyncReleaseEmails(env: Record<string, unknown> & { PUBLIC_ORIGIN: string }, main: SqlDriver, now: number) {
  const st = (await main.all<{ resync_after: number | null; resync_cursor: string | null }>(
    sql`SELECT resync_after, resync_cursor FROM health_state WHERE id = 'main'`)).results[0];
  if (!st || st.resync_after == null) return null;
  const tickets = (await main.all<{ id: string; party_id: string; guest_email: string; guest_name: string | null; link_version: number; party_name: string }>(
    sql`SELECT t.id, t.party_id, t.guest_email, t.guest_name, t.link_version, p.name AS party_name
      FROM tickets t JOIN parties p ON p.id = t.party_id
      WHERE t.released_at > ${st.resync_after} AND t.status = 'approved' AND t.hold_at IS NULL AND t.guest_email IS NOT NULL
        AND t.id > ${st.resync_cursor ?? ""}
      ORDER BY t.id LIMIT ${BATCH}`)).results;
  const have = tickets.length
    ? new Set((await main.all<{ ticket_id: string }>(sql`SELECT DISTINCT ticket_id FROM outbox
        WHERE kind = 'ticket_released' AND ticket_id IN (${join(tickets.map((t) => sql`${t.id}`), ", ")})`)).results.map((r) => r.ticket_id))
    : new Set<string>();
  const writes = [];
  for (const t of tickets) {
    if (have.has(t.id)) continue;
    const link = await signLink(env, { partyId: t.party_id, ticketId: t.id, version: t.link_version });
    writes.push(outboxInsert(releasedEmail({
      origin: env.PUBLIC_ORIGIN, partyId: t.party_id, partyName: t.party_name, ticketId: t.id, to: t.guest_email,
      guestName: t.guest_name, link, now, actor: "recovery",
    }), sql`1`));
  }
  const done = tickets.length < BATCH;
  // The cursor moves in the same batch as the emails, so a retry never queues one twice.
  writes.push(done
    ? sql`UPDATE health_state SET resync_after = NULL, resync_cursor = NULL WHERE id = 'main'`
    : sql`UPDATE health_state SET resync_cursor = ${tickets[tickets.length - 1]!.id} WHERE id = 'main'`);
  await main.batch(writes);
  return { queued: writes.length - 1, done };
}
