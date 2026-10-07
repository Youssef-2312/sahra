-- sahra-ledger: a SEPARATE D1 database from sahra-prod. Restoring sahra-prod (Time
-- Travel) does not touch this database, so the change log survives a restore and
-- recovery can replay it. WITHOUT ROWID keeps each entry to one written row.

-- One entry per entity + rev: the entity's full state after that change.
CREATE TABLE change_log (
  event_id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  action TEXT,
  logged_at INTEGER NOT NULL,
  state TEXT NOT NULL
) STRICT, WITHOUT ROWID;
