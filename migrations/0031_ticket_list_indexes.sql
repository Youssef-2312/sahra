-- Faster, cheaper staff lists (owner: the daily D1 read allowance ran out).
-- Requests and Guests show tickets of one status oldest first, 20-50 at a time.
-- tickets_party_status had no date order, so every page read every ticket of that
-- status to sort them (2-3 rows per ticket). It is rebuilt with the list order
-- (created_at, id) and still ends with people, so the "places held" sums still read
-- only the index. Same number of indexes as before: no extra rows written per ticket.
-- Additive in effect: the code works the same before and after this migration.
DROP INDEX IF EXISTS tickets_party_status;
CREATE INDEX tickets_party_status ON tickets(party_id, status, created_at, id, people);
