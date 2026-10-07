-- Phase 3: controlled recovery (section 8.3).
--
-- A ticket on hold cannot be admitted. Recovery puts a ticket on hold when its
-- latest change cannot be confirmed (the database was unreachable or did not match
-- the change log); only an owner releases the hold, with a reason (audit).
-- Additive only: existing rows get NULL (not on hold).
ALTER TABLE tickets ADD COLUMN hold_at INTEGER;
ALTER TABLE tickets ADD COLUMN hold_reason TEXT;
