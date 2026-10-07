// Changes that would be unsafe to lose in a recovery (section 8.3 step 2): a
// ticket cancel or reissue, a staff role change or disable, and similar. Their
// intent goes to the ledger BEFORE the main-database batch, under the same
// operation id the change records as `last_op`. If that write is not confirmed,
// the change is not made (the caller answers "pending, retry"): fail closed.
//
// Changes that are safe to lose need no intent (recovery revokes every session
// and unused invitation anyway): sign-in links, invitation use, staff creation,
// admission open/pause (the control object in the ledger is authoritative).

import { LogPendingError } from "./changelog";
import type { Ledger } from "./ledger";

export interface IntentTarget {
  entity: "ticket" | "staff" | "invite" | "party" | (string & {});
  id: string;
}

export async function recordIntent(ledger: Ledger, op: string, partyId: string, action: string, targets: IntentTarget[], now: number) {
  try {
    await ledger.putIntents(targets.map((t) => ({ op_id: op, entity: t.entity, entity_id: t.id, party_id: partyId, action, created_at: now })));
  } catch (e) {
    throw new LogPendingError(e);
  }
}
