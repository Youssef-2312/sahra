-- Phase 4, workstream C: guest sign-up, approval queue, release, guest ticket links.
-- Additive only.

-- The party's own sign-up form (JSON, see src/guests/form.ts): its questions and
-- whether a payment screenshot is required. Part of the party row, so a change
-- bumps the party's rev and goes through the change log like any party change.
ALTER TABLE parties ADD COLUMN guest_form TEXT;

-- Rejection reason, shown to the guest on their ticket page.
ALTER TABLE tickets ADD COLUMN reject_reason TEXT;
ALTER TABLE tickets ADD COLUMN rejected_at INTEGER;
ALTER TABLE tickets ADD COLUMN rejected_by TEXT;
-- Version of the guest's ticket link (src/guests/link.ts). A name transfer bumps
-- it, so the previous holder's link stops working (as does their QR: qr_version).
ALTER TABLE tickets ADD COLUMN link_version INTEGER NOT NULL DEFAULT 1;

-- Capacity (places held = people on pending + approved tickets) is checked inside
-- the sign-up insert and every approval. Without an index that sum would read
-- every ticket of every party; this covering index reads only the party's rows.
-- Cost: one extra row written when a ticket is inserted or its status changes.
-- The scan path changes none of these columns, so an admission still writes 2 rows.
CREATE INDEX tickets_party_status ON tickets(party_id, status, people);
