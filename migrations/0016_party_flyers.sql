-- Party pictures ("flyers", Phase 5): up to 8 images per party (owner decision:
-- more than four) that the party's owner or an admin uploads; guests see the
-- first on the home page card and all of them on the party's page. Additive only.
--
-- The bytes live in the files databases (sahra-files-N) through the storage
-- module (src/storage/), like payment screenshots: same 600,000-byte maximum,
-- same type check from the first bytes, same 70% capacity rule. No files
-- database schema change: a picture's files row is owned by "flyer:<flyer id>"
-- in its ticket_id column (only the storage module knows this).
--
-- Every rule is inside the statement that makes the change (src/party/flyers.ts):
--  - upload: the session is an active owner/admin of the party, and the party has
--    fewer than 8 pictures that are not deleted (counted in the INSERT itself, so
--    two uploads at once never make a ninth);
--  - delete: soft (deleted_at), so the change log records it like any change.
--
-- Pictures are logged entities (rev, logged_rev, last_op, last_action, audit,
-- change log, recovery replay, backup export) like ticket types.
--
-- Retention (src/storage/ purgeOldScreenshots, the daily health run): the bytes
-- of a deleted picture are removed by the next daily run; the bytes of every
-- picture 30 days after its party ended (ends_at, or 12 hours after starts_at);
-- bytes no picture row points to (an upload refused after storing) after 1 day.
-- This row stays.
CREATE TABLE party_flyers (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES parties(id),
  file_key TEXT NOT NULL,               -- storage key ("f<N>:<id>"), opaque outside src/storage/
  type TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png', 'image/webp')),
  size INTEGER NOT NULL,                -- bytes
  position INTEGER NOT NULL,            -- order on the party page, lowest first; the first is the card's picture
  created_at INTEGER NOT NULL,
  created_by TEXT,
  deleted_at INTEGER,                   -- NULL = live
  deleted_by TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  logged_rev INTEGER NOT NULL DEFAULT 0,
  last_op TEXT,
  last_action TEXT
) STRICT;

-- A party's live pictures in order: the home page list (id and rev build the
-- URL), the count in the upload's limit and the next position. Partial and
-- covering (the list reads no table row). Cost: one index row per upload, one
-- removed per delete.
CREATE INDEX party_flyers_live ON party_flyers(party_id, position, id, rev) WHERE deleted_at IS NULL;

-- The change-log flush asks for rows with rev > logged_rev (as migrations/0015):
-- only those rows are in this index, so a flush reads no logged picture.
CREATE INDEX party_flyers_unlogged ON party_flyers(id) WHERE rev > logged_rev;
