-- STAGING ONLY, TEMPORARY (Checkpoint A): stand-in tables for measuring the scan
-- path before Phase 2. Production never has them.
CREATE TABLE IF NOT EXISTS proto_tickets (
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

CREATE TABLE IF NOT EXISTS proto_scans (
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
