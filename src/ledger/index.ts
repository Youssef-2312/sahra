// The ledger: append-only records kept OUTSIDE the main database (sahra-ledger, a
// separate D1 database), so a restore of the main database cannot erase them.
// Phase 1 holds the change log; Phase 2 adds the per-party control object and the
// admission records. For the Vercel standby, implement `Ledger` on another
// SQLite-compatible database.

import type { SqlDriver } from "../db/driver";
import { sql } from "../db/sql";

export interface LogEntry {
  event_id: string;
  party_id: string;
  entity: string;
  entity_id: string;
  rev: number;
  action: string | null;
  logged_at: number;
  state: string;
}

export interface Ledger {
  /**
   * Writes entries in one transaction. Resolves only after the database has
   * committed them; throws otherwise. Re-writing an existing event id is a no-op
   * (the state for a given entity + rev never changes).
   */
  putEntries(entries: LogEntry[]): Promise<void>;
}

export class LedgerWriteError extends Error {}

export class D1Ledger implements Ledger {
  constructor(readonly driver: SqlDriver) {}

  async putEntries(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.driver.batch(
        entries.map((e) => sql`INSERT INTO change_log (event_id, party_id, entity, entity_id, rev, action, logged_at, state)
          VALUES (${e.event_id}, ${e.party_id}, ${e.entity}, ${e.entity_id}, ${e.rev}, ${e.action}, ${e.logged_at}, ${e.state})
          ON CONFLICT (event_id) DO NOTHING`),
      );
    } catch (err) {
      throw new LedgerWriteError(`ledger write failed: ${(err as Error).message}`);
    }
  }
}
