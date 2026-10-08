// The party's outbox as its owner/admins see it: list (paged), approve rows that
// await approval, cancel unsent rows. Every rule, including the session check,
// is inside the statement that reads or changes the rows.

import { sessionValid, type SessionRef } from "../db";
import type { SqlDriver } from "../db/driver";
import { sql, type Sql } from "../db/sql";

export const OUTBOX_PAGE = 50;
/** Most ids per bulk request. */
export const OUTBOX_BULK_MAX = 500;

export type Selection = { ids: string[] } | { allAwaiting: true };

export interface Cursor {
  at: number;
  id: string;
}

function selected(s: Selection): Sql {
  if ("ids" in s) return sql`id IN (SELECT value FROM json_each(${JSON.stringify(s.ids)}))`;
  return sql`status = 'awaiting_approval'`;
}

export class OutboxAdmin {
  constructor(private readonly driver: SqlDriver) {}

  /** Newest first; `before` continues after the last row of the previous page. */
  async list(sess: SessionRef, now: number, status: string | null, before: Cursor | null) {
    const ok = sessionValid(sess, ["owner", "admin"], now);
    const after = before
      ? sql`AND (created_at < ${before.at} OR (created_at = ${before.at} AND id < ${before.id}))`
      : sql``;
    const r = await this.driver.all<Record<string, unknown>>(sql`SELECT id, kind, to_email, ticket_id, subject, body_text, status,
        created_at, created_by, approved_at, approved_by, attempts, next_attempt_at, sent_at, provider, last_error, cancelled_at, cancelled_by
      FROM outbox WHERE party_id = ${sess.partyId} AND ${ok} ${status ? sql`AND status = ${status}` : sql``} ${after}
      ORDER BY created_at DESC, id DESC LIMIT ${OUTBOX_PAGE + 1}`);
    const rows = r.results.slice(0, OUTBOX_PAGE);
    const last = rows.at(-1);
    const next = r.results.length > OUTBOX_PAGE && last ? `${last.created_at}.${last.id}` : null;
    return { rows, next };
  }

  /** awaiting_approval -> queued (due now). Returns how many rows changed. */
  async approve(sess: SessionRef, actor: string, s: Selection, now: number): Promise<number> {
    const ok = sessionValid(sess, ["owner", "admin"], now);
    const r = await this.driver.all(sql`UPDATE outbox SET status = 'queued', approved_at = ${now}, approved_by = ${actor}, next_attempt_at = ${now}
      WHERE party_id = ${sess.partyId} AND status = 'awaiting_approval' AND ${selected(s)} AND ${ok}`);
    return r.meta.changes;
  }

  /** awaiting_approval or queued -> cancelled. A row being sent right now cannot be withdrawn. */
  async cancel(sess: SessionRef, actor: string, s: Selection, now: number): Promise<number> {
    const ok = sessionValid(sess, ["owner", "admin"], now);
    const r = await this.driver.all(sql`UPDATE outbox SET status = 'cancelled', cancelled_at = ${now}, cancelled_by = ${actor}, next_attempt_at = NULL
      WHERE party_id = ${sess.partyId} AND status IN ('awaiting_approval', 'queued') AND ${selected(s)} AND ${ok}`);
    return r.meta.changes;
  }
}
