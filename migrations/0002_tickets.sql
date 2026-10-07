-- Phase 2: tickets and scans.
--
-- Write cost matters (Workers Free: 100,000 rows written per day for the account):
-- both tables are WITHOUT ROWID with a TEXT primary key, so an insert or update is
-- one written row, and there are no secondary indexes on the scan path.
-- `used_scan_id` is not separately indexed: a scan id maps to exactly one ticket
-- through `scans.scan_id` (primary key), and the redemption statement requires
-- that no scan row with this scan id exists before it marks a ticket used.

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,                -- 16 Crockford base32 characters (80 random bits)
  party_id TEXT NOT NULL REFERENCES parties(id),
  qr_version INTEGER NOT NULL DEFAULT 1 CHECK (qr_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'archived')),
  people INTEGER NOT NULL DEFAULT 1 CHECK (people >= 1),
  guest_name TEXT,
  guest_email TEXT,
  answers TEXT,                       -- JSON of the party's form answers (Phase 4)
  screenshot_key TEXT,                -- Phase 4
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by TEXT,
  released_at INTEGER,
  released_by TEXT,
  used_scan_id TEXT,
  used_at INTEGER,
  used_by TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  logged_rev INTEGER NOT NULL DEFAULT 0,
  last_op TEXT,
  last_action TEXT
) STRICT, WITHOUT ROWID;

-- One row per physical scan (scan_id chosen by the scanner, reused only for retries
-- of that same scan). Inserted with its FINAL outcome in the same transaction as
-- the ticket update, so no attempt is ever left pending.
CREATE TABLE scans (
  scan_id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  qr_version INTEGER NOT NULL,
  qr_fingerprint TEXT NOT NULL,       -- SHA-256 of the exact QR text
  pause_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('admitted', 'already_used', 'not_approved', 'not_released', 'old_version', 'unknown_ticket', 'paused')),
  ticket_rev INTEGER                  -- the ticket's rev right after this scan (admission rev when admitted)
) STRICT, WITHOUT ROWID;
