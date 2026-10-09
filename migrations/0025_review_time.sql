-- Expected review time (brainstorm idea 15): a short line from the organiser, for
-- example "Usually within 24 hours", shown to guests after they ask for a ticket
-- and on their ticket page while the request waits. NULL = not shown.
ALTER TABLE parties ADD COLUMN review_time TEXT;
