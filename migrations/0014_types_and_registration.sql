-- Ticket types and registration rules (owner request, 2026-10-08). Additive only.
--
-- Ticket types: each party may define its own (for example "Early" and
-- "Regular"), each with a price, an optional number of places, an optional sales
-- window, an optional "entry from" time at the door, and payment instructions.
-- A party with no types works as before (tickets without a type). "Early" is an
-- ordinary type: the owner decides what it means (an early-bird sales window, an
-- earlier entry time, or both).
--
-- Every rule is checked inside the statement that makes the change
-- (src/guests/db.ts, src/db/tickets.ts):
--  - sign-up: the type exists for the party, is not archived or staff-only, is in
--    its sales window, and its places hold (people on pending + approved tickets
--    of that type + this request <= quantity); the party's capacity as before;
--  - approval: approved people of the type + this ticket <= quantity;
--  - door: a ticket whose type has entry_from in the future is refused (the
--    redemption UPDATE requires it), so it never shows green early.
--
-- Types are logged entities (rev, logged_rev, last_op, last_action, audit, change
-- log) like parties and staff, so recovery and backups cover them.
CREATE TABLE ticket_types (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES parties(id),
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL DEFAULT 0,     -- whole Egyptian pounds (EGP) per person; 0 = free
  quantity INTEGER,                     -- places (people) of this type; NULL = only the party capacity limits it
  sales_opens_at INTEGER,               -- Unix ms; NULL = open now
  sales_closes_at INTEGER,              -- Unix ms; NULL = no end
  entry_from INTEGER,                   -- Unix ms; the door refuses this type before it; NULL = no limit
  staff_only INTEGER NOT NULL DEFAULT 0 CHECK (staff_only IN (0, 1)),  -- not on the public form; issued by staff (complimentary)
  payment_instructions TEXT,            -- shown on the sign-up form for this type; NULL = the party's own
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,                  -- no new tickets; existing tickets keep their type
  created_at INTEGER NOT NULL,
  created_by TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  logged_rev INTEGER NOT NULL DEFAULT 0,
  last_op TEXT,
  last_action TEXT
) STRICT;
CREATE INDEX ticket_types_party ON ticket_types(party_id, sort);
-- Every change-log flush asks for rows "rev > logged_rev". This partial index holds
-- only those rows, so a flush reads none of the (growing) logged types. Cost: one
-- index row written when a type changes, one removed when it is logged.
CREATE INDEX ticket_types_unlogged ON ticket_types(id) WHERE rev > logged_rev;

-- The ticket's type, and its price per person when it was requested (the type's
-- price may change later; the guest paid what the form showed).
ALTER TABLE tickets ADD COLUMN type_id TEXT REFERENCES ticket_types(id);
ALTER TABLE tickets ADD COLUMN price INTEGER;
-- Places held per type, checked in every sign-up and approval. Partial: untyped
-- tickets write nothing here. Neither column changes on the scan path, so an
-- admission still writes 2 rows.
CREATE INDEX tickets_type_status ON tickets(type_id, status, people) WHERE type_id IS NOT NULL;
-- "Max tickets per email" and the duplicate warning read only this address's
-- tickets. Written on insert and on a name transfer with a new email only (tickets
-- without an email, such as staff-issued ones, write nothing here).
CREATE INDEX tickets_party_email ON tickets(party_id, guest_email) WHERE guest_email IS NOT NULL;

-- Registration rules (party edit, src/party/input.ts). NULL = no rule.
ALTER TABLE parties ADD COLUMN registration_opens_at INTEGER;
ALTER TABLE parties ADD COLUMN registration_closes_at INTEGER;
-- Pending + approved tickets per guest email address (rejected and cancelled ones do not count).
ALTER TABLE parties ADD COLUMN max_tickets_per_email INTEGER;
