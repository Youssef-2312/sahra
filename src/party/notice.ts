// "Time or place changed" notice to every ticket holder (feature: party details
// edit with "notify guests"). Rows go to the email outbox awaiting the party
// owner/admin's approval, in the same batch as the edit, so they exist if and only
// if the edit committed. Nothing is sent from here.
//
// One INSERT ... SELECT covers every recipient: a statement per guest would hit
// D1's 50-queries-per-request limit (Workers Free) for any real party. The row
// shape and plain-text check are those of outboxInsert (src/outbox.ts).
//
// The text never contains the place: guests may not be allowed to see it yet (and
// the email is sent later, after approval). It points them to their ticket page.

import { sql, type Sql } from "../db/sql";
import { assertPlainText } from "../outbox";
import { formatHuman } from "./time";

/** At most this many notice rows per edit (each is one written row). */
export const MAX_NOTICES_PER_EDIT = 1000;

export function noticeText(p: { name: string; starts_at: number | null; ends_at: number | null; time_zone: string | null }) {
  const tz = p.time_zone ?? "UTC";
  const lines = [`The details of ${p.name} have changed.`, ""];
  if (p.starts_at !== null) lines.push(`Starts: ${formatHuman(p.starts_at, tz)}`);
  if (p.ends_at !== null) lines.push(`Ends: ${formatHuman(p.ends_at, tz)}`);
  if (p.starts_at !== null || p.ends_at !== null) lines.push("");
  lines.push("Please open your ticket page for the current time and place.");
  const subject = `Update: ${p.name}`;
  const body = lines.join("\n");
  assertPlainText(subject);
  assertPlainText(body);
  return { subject, body };
}

/** Approved, released tickets of the party that have an email address. */
export function noticeRecipients(partyId: string): Sql {
  return sql`SELECT id, guest_email FROM tickets
    WHERE party_id = ${partyId} AND status = 'approved' AND released_at IS NOT NULL AND guest_email IS NOT NULL`;
}

/**
 * One outbox row per recipient, status awaiting_approval, only when `guard` holds
 * (the edit happened). Ids are `notice:<op>:<ticket>`, so the same edit can never
 * queue a guest twice.
 */
export function noticeInsert(a: { partyId: string; op: string; subject: string; body: string; now: number; createdBy: string }, guard: Sql): Sql {
  return sql`INSERT INTO outbox (id, party_id, kind, to_email, ticket_id, subject, body_text, status, created_at, created_by, next_attempt_at)
    SELECT 'notice:' || ${a.op} || ':' || r.id, ${a.partyId}, 'party_notice', r.guest_email, r.id, ${a.subject}, ${a.body},
      'awaiting_approval', ${a.now}, ${a.createdBy}, NULL
    FROM (${noticeRecipients(a.partyId)} ORDER BY id LIMIT ${MAX_NOTICES_PER_EDIT}) r
    WHERE ${guard}
    ON CONFLICT (id) DO NOTHING`;
}
