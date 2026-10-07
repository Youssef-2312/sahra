-- TEMPORARY (Checkpoint A only): stand-in tables for measuring the scan path's CPU
-- time and rows written before Phase 2. Phase 2 drops these and adds the real ones.
CREATE TABLE proto_tickets (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  qr_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'approved',
  released_at INTEGER,
  used_scan_id TEXT UNIQUE,
  used_at INTEGER,
  used_by TEXT,
  rev INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE proto_scans (
  scan_id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  qr_version INTEGER NOT NULL,
  qr_fingerprint TEXT NOT NULL,
  pause_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  outcome TEXT NOT NULL
) STRICT;
