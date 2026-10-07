// The ledger: append-only records kept OUTSIDE the main database (sahra-ledger, a
// separate D1 database), so a restore of the main database cannot erase them.
// It holds the change log (including admission records: a ticket's state at its
// admission rev) and the per-party control object. For the Vercel standby, implement `Ledger` on another
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

/** Per-party control object (section 7.2). */
export interface Control {
  state: "open" | "paused";
  pause_number: number;
  rev: number;
}

export interface Ledger {
  /**
   * Writes entries in one transaction. Resolves only after the database has
   * committed them; throws otherwise. Re-writing an existing event id is a no-op
   * (the state for a given entity + rev never changes).
   */
  putEntries(entries: LogEntry[]): Promise<void>;
  /** The party's control object, or null if it was never created (= paused). */
  getControl(partyId: string): Promise<Control | null>;
  /**
   * Conditional write: applies only if the stored rev equals `expectedRev`
   * (0 = must not exist yet). Returns false if another update got there first.
   */
  setControl(partyId: string, expectedRev: number, next: Pick<Control, "state" | "pause_number">, now: number, by: string | null): Promise<boolean>;
  /**
   * Green-screen step (section 7.4) in ONE ledger batch: write the admission
   * record idempotently, then re-read the control object. Resolves only after the
   * write is committed (returns the control object read after it); throws otherwise.
   */
  recordAdmission(entry: LogEntry): Promise<Control | null>;
  /** Writes intents in one transaction (idempotent). Resolves only after the commit; throws otherwise. */
  putIntents(intents: Intent[]): Promise<void>;
}

/** A change about to be made (written BEFORE the main-database batch). */
export interface Intent {
  op_id: string;
  entity: string;
  entity_id: string;
  party_id: string;
  action: string;
  created_at: number;
}

export class LedgerWriteError extends Error {}

function insertEntry(e: LogEntry) {
  return sql`INSERT INTO change_log (event_id, party_id, entity, entity_id, rev, action, logged_at, state)
    VALUES (${e.event_id}, ${e.party_id}, ${e.entity}, ${e.entity_id}, ${e.rev}, ${e.action}, ${e.logged_at}, ${e.state})
    ON CONFLICT (event_id) DO NOTHING`;
}

function asControl(r: Record<string, unknown> | undefined): Control | null {
  if (!r) return null;
  return { state: r.state === "open" ? "open" : "paused", pause_number: Number(r.pause_number), rev: Number(r.rev) };
}

export class D1Ledger implements Ledger {
  constructor(readonly driver: SqlDriver) {}

  async getControl(partyId: string): Promise<Control | null> {
    const r = await this.driver.all(sql`SELECT state, pause_number, rev FROM party_control WHERE party_id = ${partyId}`);
    return asControl(r.results[0]);
  }

  async setControl(partyId: string, expectedRev: number, next: Pick<Control, "state" | "pause_number">, now: number, by: string | null): Promise<boolean> {
    const r = expectedRev === 0
      ? await this.driver.all(sql`INSERT INTO party_control (party_id, state, pause_number, rev, updated_at, updated_by)
          VALUES (${partyId}, ${next.state}, ${next.pause_number}, 1, ${now}, ${by}) ON CONFLICT (party_id) DO NOTHING`)
      : await this.driver.all(sql`UPDATE party_control SET state = ${next.state}, pause_number = ${next.pause_number},
          rev = rev + 1, updated_at = ${now}, updated_by = ${by}
          WHERE party_id = ${partyId} AND rev = ${expectedRev}`);
    return r.meta.changes === 1;
  }

  async recordAdmission(entry: LogEntry): Promise<Control | null> {
    let rs;
    try {
      rs = await this.driver.batch([
        insertEntry(entry),
        sql`SELECT state, pause_number, rev FROM party_control WHERE party_id = ${entry.party_id}`,
      ]);
    } catch (err) {
      throw new LedgerWriteError(`admission record not confirmed: ${(err as Error).message}`);
    }
    return asControl(rs[1]!.results[0]);
  }

  async putIntents(intents: Intent[]): Promise<void> {
    if (intents.length === 0) return;
    try {
      await this.driver.batch(intents.map((i) => sql`INSERT INTO intents (op_id, entity, entity_id, party_id, action, created_at)
        VALUES (${i.op_id}, ${i.entity}, ${i.entity_id}, ${i.party_id}, ${i.action}, ${i.created_at})
        ON CONFLICT DO NOTHING`));
    } catch (err) {
      throw new LedgerWriteError(`intent not confirmed: ${(err as Error).message}`);
    }
  }

  async putEntries(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.driver.batch(
        entries.map(insertEntry),
      );
    } catch (err) {
      throw new LedgerWriteError(`ledger write failed: ${(err as Error).message}`);
    }
  }
}
