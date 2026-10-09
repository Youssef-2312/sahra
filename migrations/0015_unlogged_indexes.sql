-- The change-log flush (src/db/index.ts unlogged(), run after every change and by
-- the health check) asks each small table for its rows with rev > logged_rev.
-- Without an index that reads the whole table every time: measured on staging
-- after the load test, about 480 rows per door join. These partial indexes hold
-- only the rows still waiting for the change log, so a flush reads nothing when
-- nothing is pending, however many parties, staff and invitations there are
-- (ticket_types already has one, migrations/0014).
--
-- Cost: one index row written when such a row changes and one removed when it is
-- logged (about +2 rows written per change of a party, staff member, invitation,
-- site owner or organiser). Tickets are deliberately NOT indexed this way: an
-- admission bumps the ticket's rev without updating logged_rev (its record goes
-- to the ledger on the scan path), so an index would add a row write to every
-- admission. Additive only.
CREATE INDEX parties_unlogged ON parties(id) WHERE rev > logged_rev;
CREATE INDEX staff_unlogged ON staff(id) WHERE rev > logged_rev;
CREATE INDEX invites_unlogged ON invites(id) WHERE rev > logged_rev;
CREATE INDEX platform_admins_unlogged ON platform_admins(id) WHERE rev > logged_rev;
CREATE INDEX organisers_unlogged ON organisers(id) WHERE rev > logged_rev;
CREATE INDEX organiser_invites_unlogged ON organiser_invites(id) WHERE rev > logged_rev;
