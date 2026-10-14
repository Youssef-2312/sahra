-- Opt-in individual QR tickets for group bookings. Existing tickets stay unchanged.
ALTER TABLE ticket_types ADD COLUMN individual_tickets INTEGER NOT NULL DEFAULT 0 CHECK (individual_tickets IN (0, 1));
ALTER TABLE tickets ADD COLUMN split_group_size INTEGER CHECK (split_group_size IS NULL OR split_group_size >= 1);
