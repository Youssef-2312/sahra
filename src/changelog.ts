// Change log (section 8.1): every change to a party, staff or invite row bumps its
// rev; its full state after the change is written to the ledger (sahra-ledger)
// under entity + rev BEFORE the change is confirmed to the user. `logged_rev` in
// the main database records what the ledger has confirmed. A failed or
// unconfirmed write leaves the row unlogged; any later request (including a retry
// of the same action) finishes it.

import type { Db } from "./db";
import type { Ledger } from "./ledger";

export class LogPendingError extends Error {
  constructor(readonly cause?: unknown) {
    super("change log write not confirmed");
  }
}

// Bounded per request (each request may make only a limited number of D1 queries
// on the Workers Free plan); the entries go to the ledger in one batch.
const MAX_PER_REQUEST = 20;

export async function flushChangeLog(db: Db, ledger: Ledger, now: number): Promise<number> {
  const all = await db.unlogged(MAX_PER_REQUEST + 1);
  if (all.length === 0) return 0;
  const rows = all.slice(0, MAX_PER_REQUEST);
  try {
    await ledger.putEntries(
      rows.map((r) => ({
        event_id: `${r.entity}:${r.id}:${r.rev}`,
        party_id: r.party_id,
        entity: r.entity,
        entity_id: r.id,
        rev: r.rev,
        action: typeof r.state.last_action === "string" ? r.state.last_action : null,
        logged_at: now,
        state: JSON.stringify(r.state),
      })),
    );
  } catch (e) {
    throw new LogPendingError(e);
  }
  await db.markLogged(rows.map((r) => ({ entity: r.entity, id: r.id, rev: r.rev })));
  // More rows than one request may write: report pending; the retry continues.
  if (all.length > MAX_PER_REQUEST) throw new LogPendingError("backlog");
  return rows.length;
}
