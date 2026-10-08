-- Owner decision: a site owner can manage any party. Entering a party gives the
-- site owner an ordinary owner staff row there (linked to their Google account)
-- and an ordinary owner session, so every party feature and its authority
-- checks apply unchanged. `site_owner_id` marks such rows: they do not count as
-- the party's own owner ("no active owner"), and removing the site owner
-- disables them. NULL for every other staff row. Additive only.
ALTER TABLE staff ADD COLUMN site_owner_id TEXT;
