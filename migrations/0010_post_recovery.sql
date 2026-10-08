-- Audit follow-ups (additive only).
--
-- resync_after / resync_cursor: set by a controlled recovery (scripts/recover.mjs)
--   to the restore point. Outbox rows created after it are gone with the restore,
--   so the health run rebuilds the "your ticket" email for every ticket released
--   after that point that has none (src/recovery/resync.ts), then clears it.
-- last_hourly_backup_at: the latest verified HOURLY backup (ledger + new
--   screenshots), so missed hourly backups alert on their own threshold;
--   last_backup_at stays the latest FULL (nightly) backup.
ALTER TABLE health_state ADD COLUMN resync_after INTEGER;
ALTER TABLE health_state ADD COLUMN resync_cursor TEXT;
ALTER TABLE health_state ADD COLUMN last_hourly_backup_at INTEGER;
