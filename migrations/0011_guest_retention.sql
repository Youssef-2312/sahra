-- Workstream C follow-up: when a ticket was cancelled (and by whom), so its payment
-- screenshot can be deleted 30 days later (src/storage/ purgeOldScreenshots).
-- Tickets cancelled before this migration keep NULL: their screenshot is deleted
-- only by the "30 days after the party" rule. Additive only.
ALTER TABLE tickets ADD COLUMN cancelled_at INTEGER;
ALTER TABLE tickets ADD COLUMN cancelled_by TEXT;
