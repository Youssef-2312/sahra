-- Screenshot retention (src/storage/: purgeOldScreenshots). Additive only.
--
-- A deleted screenshot keeps its files row (party, ticket, type and original size,
-- as listed in the backups) with empty bytes, plus a tombstone here saying why, so
-- the approval queue can explain it. The bytes stay in the Drive backup.
CREATE TABLE file_tombstones (
  id INTEGER PRIMARY KEY,
  party_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  reason TEXT NOT NULL
) STRICT;

-- The daily purge reads every live file's party, ticket and time. This covering
-- index answers that without touching the BLOBs (which sit before created_at in
-- each row). Cost: one extra row written per upload.
CREATE INDEX files_meta ON files(party_id, ticket_id, created_at);
