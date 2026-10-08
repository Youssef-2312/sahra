-- Phase 4 workstream A: party details, address modes and reveal.
--
-- Additive only: new columns on `parties` (a logged entity, so every edit bumps
-- rev and the full row, including these columns, goes to the change log). Existing
-- parties get NULL details and address_mode 'manual' with nothing revealed: the
-- most closed mode, so nothing is shown until an owner/admin chooses.
--
-- Times are UTC instants in Unix ms; `time_zone` is the party's IANA zone (for
-- example 'Africa/Cairo'), used only to display and to enter local times.
--
-- address_mode:
--   public       address shown on the public party page
--   with_ticket  shown to a released, approved ticket that is not on hold
--   at_time      as with_ticket, but only from reveal_at on
--   manual       as with_ticket, but only once an owner/admin pressed "Reveal now" (revealed_at)
-- address_locked_at: from this instant on, the place (venue, address, map link)
-- and the lock itself can no longer be changed.
--
-- No new index: every statement reads parties by primary key.

ALTER TABLE parties ADD COLUMN description TEXT;
ALTER TABLE parties ADD COLUMN starts_at INTEGER;
ALTER TABLE parties ADD COLUMN ends_at INTEGER;
ALTER TABLE parties ADD COLUMN time_zone TEXT;
ALTER TABLE parties ADD COLUMN venue_name TEXT;
ALTER TABLE parties ADD COLUMN address TEXT;
ALTER TABLE parties ADD COLUMN map_url TEXT;
ALTER TABLE parties ADD COLUMN rules TEXT;
ALTER TABLE parties ADD COLUMN payment_instructions TEXT;
ALTER TABLE parties ADD COLUMN address_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (address_mode IN ('public', 'with_ticket', 'at_time', 'manual'));
ALTER TABLE parties ADD COLUMN reveal_at INTEGER;
ALTER TABLE parties ADD COLUMN revealed_at INTEGER;
ALTER TABLE parties ADD COLUMN address_locked_at INTEGER;
