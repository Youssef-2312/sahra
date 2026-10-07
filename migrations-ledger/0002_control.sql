-- Per-party control object (section 7.2), kept in the ledger database so a
-- restore of the main database cannot undo a pause. Updated only with a
-- conditional write on `rev` (the equivalent of an etag), so two updates cannot race.
CREATE TABLE party_control (
  party_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('open', 'paused')),
  pause_number INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
) STRICT, WITHOUT ROWID;
