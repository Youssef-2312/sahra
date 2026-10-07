// Change log (section 8.1): every change to a party, staff or invite row bumps its
// rev; its full state after the change is written to R2 under entity + rev BEFORE
// the change is confirmed to the user. `logged_rev` in D1 records what R2 has
// confirmed. A failed or unconfirmed write leaves the row unlogged; any later
// request (including a retry of the same action) finishes it.

import type { Db } from "./db";
import { logKey, type ObjectStore } from "./storage";

export class LogPendingError extends Error {
  constructor(readonly cause?: unknown) {
    super("change log write not confirmed");
  }
}

/**
 * Writes every unlogged row to R2 and marks it logged. Throws LogPendingError if
 * any write is not confirmed. Writing the same entity+rev twice is harmless: the
 * state for a given rev never changes.
 */
// Kept small: on the Workers Free plan each R2 call is a subrequest, and a request
// may make only a limited number of them.
const MAX_PER_REQUEST = 20;

export async function flushChangeLog(db: Db, store: ObjectStore, now: number): Promise<number> {
  const all = await db.unlogged(MAX_PER_REQUEST + 1);
  if (all.length === 0) return 0;
  const rows = all.slice(0, MAX_PER_REQUEST);
  const done: { entity: (typeof rows)[number]["entity"]; id: string; rev: number }[] = [];
  let failure: unknown = null;
  {
    await Promise.all(
      rows.map(async (r) => {
        const entry = {
          v: 1,
          event_id: `${r.entity}:${r.id}:${r.rev}`,
          entity: r.entity,
          id: r.id,
          party_id: r.party_id,
          rev: r.rev,
          action: r.state.last_action ?? null,
          logged_at: now,
          state: r.state,
        };
        try {
          await store.put(logKey(r.party_id, r.entity, r.id, r.rev), JSON.stringify(entry), "application/json");
          done.push({ entity: r.entity, id: r.id, rev: r.rev });
        } catch (e) {
          failure = e;
        }
      }),
    );
  }
  await db.markLogged(done);
  if (failure) throw new LogPendingError(failure);
  // More rows than one request may write: report pending; the retry continues.
  if (all.length > MAX_PER_REQUEST) throw new LogPendingError("backlog");
  return done.length;
}
