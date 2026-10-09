-- Guest details deleted 7 days after the party (owner decision, 2026-10-09).
-- Additive only.
--
-- The daily health run (src/guests/retention.ts) clears guest_name, guest_email,
-- answers and reject_reason on every ticket of a party that ended more than 7
-- days ago, the same fields in every change-log copy of those tickets, their
-- rejection reasons in the audit log, and the party's email texts. This table
-- records the parties it has finished, so later runs skip them (a ticket created
-- after done_at brings the party back). Not a logged entity: it holds no guest
-- data and is rebuilt by simply running again.
CREATE TABLE guest_erasures (
  party_id TEXT PRIMARY KEY,
  done_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
