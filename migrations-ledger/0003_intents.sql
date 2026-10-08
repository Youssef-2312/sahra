-- Phase 3: change intents (section 8.3 step 2).
--
-- Before a change that would be unsafe to lose (ticket cancel or reissue, staff
-- role change or disable, ...), its intent is written here: the operation id and
-- every entity it may change. The change's change-log entry later carries the same
-- operation id (state.last_op). If the main database cannot be checked during a
-- recovery, an intent without a matching entry marks that entity as possibly
-- changed, and recovery holds it until an owner resolves it.
CREATE TABLE intents (
  op_id TEXT NOT NULL,
  entity TEXT NOT NULL,          -- 'ticket' | 'staff' | 'invite' | 'party' | later entities
  entity_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (op_id, entity, entity_id)
) STRICT, WITHOUT ROWID;
