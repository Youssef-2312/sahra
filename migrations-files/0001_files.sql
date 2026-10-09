-- sahra-files-N: payment screenshots (src/storage/). A separate D1 database, so
-- large BLOBs never slow the main database or its exports.
--
-- One row per file. `id` is an INTEGER PRIMARY KEY (the rowid): rows hold BLOBs of
-- up to 1.5 MB, which SQLite stores better in a rowid table than WITHOUT ROWID, and
-- an insert is one written row (no separate index). The id is derived from the
-- guest's sign-up token, so a retried sign-up writes the same row again (a no-op).
-- Reads must match party_id and ticket_id too.
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  party_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
