-- Terms acceptance on ticket requests (Phase 5, owner request). Additive only.
--
-- A guest's request now needs the "I agree to Sahra's Terms" box (and the party's
-- entry rules when the party has them). The server checks it and records, on the
-- ticket row, in the same INSERT that creates the request:
--  - terms_version: Sahra's Terms the guest accepted (src/guests/policy.ts);
--  - rules_version: the party's entry rules accepted ("r-" + hash of the text),
--    NULL when the party had no rules at that moment;
--  - privacy_version: the privacy notice shown on the form;
--  - terms_accepted_at: server time of the request.
-- The versions are the server's own, never values taken from the browser; a form
-- showing older versions is refused (terms_changed) before anything is stored.
--
-- Requests made before this migration, and tickets issued by staff, keep NULL in
-- all four: their acceptance is unknown and is never filled in afterwards. No IP
-- address or other identifier is stored for this. Accepting is not a marketing
-- opt-in.
--
-- Tickets are logged entities; the change log copies every column, so recovery and
-- backups carry these too. Not written on the scan path (an admission still writes
-- 2 rows).
ALTER TABLE tickets ADD COLUMN terms_version TEXT;
ALTER TABLE tickets ADD COLUMN rules_version TEXT;
ALTER TABLE tickets ADD COLUMN privacy_version TEXT;
ALTER TABLE tickets ADD COLUMN terms_accepted_at INTEGER;
