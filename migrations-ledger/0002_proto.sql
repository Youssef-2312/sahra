-- TEMPORARY (Checkpoint A, staging only): stand-ins for the per-party control
-- object and the admission log, used by the scan prototype. Replaced in Phase 2.
CREATE TABLE proto_control (
  party_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  pause_number INTEGER NOT NULL,
  rev INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE proto_admissions (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL
) STRICT, WITHOUT ROWID;
