-- Nullable additive fields preserve older recovery snapshots. No ticket is changed.
ALTER TABLE ticket_types ADD COLUMN wave_mode TEXT CHECK (wave_mode IN ('manual', 'scheduled', 'sales', 'sold_out'));
ALTER TABLE ticket_types ADD COLUMN wave_after_id TEXT;
ALTER TABLE ticket_types ADD COLUMN wave_after_sales INTEGER CHECK (wave_after_sales BETWEEN 1 AND 100000);
-- Historic approvals make automatic opening stable after cancellations.
CREATE INDEX tickets_type_approved ON tickets(type_id, approved_at, order_id, people) WHERE type_id IS NOT NULL AND approved_at IS NOT NULL;
