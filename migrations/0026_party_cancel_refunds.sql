-- Cancelling a party and tracking refunds (brainstorm idea 14, owner: "yes").
--
-- A cancelled party stops new requests and admission (the owner's cancel action
-- pauses admission first), and its guests can be sent a notice through the
-- outbox (awaiting approval, like any message to guests).
--
-- Refunds are tracked SEPARATELY from ticket status: "due" and "done". Sahra only
-- records them; it never sends money. The organiser pays back outside Sahra and
-- ticks "refund done". One row per ticket; amount = price per person x people,
-- whole EGP, as shown when the guest asked. Kept apart from `tickets` so marking
-- refunds never changes a ticket the door reads (and adds no change-log entries).
ALTER TABLE parties ADD COLUMN cancelled_at INTEGER;
ALTER TABLE parties ADD COLUMN cancel_reason TEXT;

CREATE TABLE refunds (
  ticket_id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  state TEXT NOT NULL CHECK (state IN ('due', 'done')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX refunds_party ON refunds(party_id, state);
