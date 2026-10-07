// TEMPORARY (Checkpoint A, staging only): control object and admission records
// for the scan prototype, in the ledger database. Replaced in Phase 2.

import type { SqlDriver } from "../db/driver";
import { sql } from "../db/sql";

export class ProtoLedger {
  constructor(private readonly driver: SqlDriver) {}

  async ensureOpen(partyId: string): Promise<void> {
    await this.driver.all(sql`INSERT INTO proto_control (party_id, state, pause_number, rev)
      VALUES (${partyId}, 'open', 0, 1) ON CONFLICT (party_id) DO NOTHING`);
  }

  async control(partyId: string): Promise<{ state: string; pause_number: number } | null> {
    const r = await this.driver.all<{ state: string; pause_number: number }>(
      sql`SELECT state, pause_number FROM proto_control WHERE party_id = ${partyId}`,
    );
    return r.results[0] ?? null;
  }

  /** Resolves only after the record is committed; idempotent per key. */
  async recordAdmission(key: string, state: string): Promise<void> {
    await this.driver.all(sql`INSERT INTO proto_admissions (key, state) VALUES (${key}, ${state}) ON CONFLICT (key) DO NOTHING`);
  }
}
