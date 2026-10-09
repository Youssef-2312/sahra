// The email outbox (migrations/0004_outbox.sql). Producers add rows INSIDE the
// batch of the change that causes them, so an email exists if and only if its
// change committed. Sending is not built yet (separate workstream, provider chosen
// by the owner); nothing here sends anything.

import { sql, type Sql } from "./db/sql";

export type OutboxKind = "ticket_released" | "ticket_link" | "party_notice" | "email_changed" | (string & {});

export interface OutboxRow {
  id: string;
  partyId: string;
  kind: OutboxKind;
  toEmail: string;
  ticketId?: string | null;
  subject: string;
  bodyText: string;
  now: number;
  createdBy: string | null;
  /** true: a party owner/admin must approve before it can be sent. */
  needsApproval: boolean;
}

/** Plain text only, no emojis (brief rule 6): refuses the emoji and pictograph ranges. */
export function assertPlainText(s: string): void {
  if (/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(s)) throw new Error("emails must not contain emojis");
}

/**
 * An INSERT for the outbox, for use inside a batch. `guard` is an SQL condition
 * (for example the session check or "the ticket was just released by this op"),
 * so the row is added only when the change itself happens.
 */
export function outboxInsert(r: OutboxRow, guard: Sql): Sql {
  assertPlainText(r.subject);
  assertPlainText(r.bodyText);
  return sql`INSERT INTO outbox (id, party_id, kind, to_email, ticket_id, subject, body_text, status, created_at, created_by, next_attempt_at)
    SELECT ${r.id}, ${r.partyId}, ${r.kind}, ${r.toEmail}, ${r.ticketId ?? null}, ${r.subject}, ${r.bodyText},
      ${r.needsApproval ? "awaiting_approval" : "queued"}, ${r.now}, ${r.createdBy}, ${r.needsApproval ? null : r.now}
    WHERE ${guard}`;
}
