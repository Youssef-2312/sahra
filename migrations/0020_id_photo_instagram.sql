-- ID photos and Instagram handles on ticket requests (owner request). Additive only.
--
-- A party's sign-up form (parties.guest_form, JSON, src/guests/form.ts) can now
-- ask for each one: "none" (default), "optional" or "required", checked by the
-- server on every request.
--  - instagram: the handle only (no @, lower case, Instagram's own rules: 1-30
--    letters, digits, dots and underscores); a pasted profile link is reduced to it.
--  - id_photo_key: the stored ID photo, in the files databases like the payment
--    screenshot (owner "idphoto:<ticket id>"). Owner/admin only, never door staff.
-- Both are guest details: deleted 7 days after the party with the others
-- (src/guests/retention.ts for the handle; the daily file purge for the photo,
-- which also deletes it 7 days after a rejection or cancellation). Not written on
-- the scan path.
ALTER TABLE tickets ADD COLUMN instagram TEXT;
ALTER TABLE tickets ADD COLUMN id_photo_key TEXT;
