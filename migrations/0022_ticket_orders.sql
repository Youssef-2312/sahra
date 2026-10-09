-- Several separate tickets in one request (owner: "if I buy for 3 of my friends who
-- may come late, they each have their separate QR"). Additive only.
--
-- One request can now make up to 10 tickets. Each is an ordinary ticket with its own
-- link and QR code (each admits its own people, once), so friends can arrive
-- separately. order_id is the first ticket's id on every ticket of a request of two or
-- more (NULL for a single ticket); the payment proof, ID photo, answers and Instagram
-- handle are kept on the first ticket only. All the tickets of a request are created
-- in one statement, all or none: the party's capacity, the type's places and the
-- tickets-per-email limit are checked for the whole order. Organisers see one card per
-- order and approve or send it at once.
ALTER TABLE tickets ADD COLUMN order_id TEXT;
-- The order's tickets, by party (queue cards, the guest's "your tickets" answer).
CREATE INDEX tickets_order ON tickets(party_id, order_id) WHERE order_id IS NOT NULL;
