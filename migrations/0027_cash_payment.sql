-- Guests who paid in cash (brainstorm ideas 9 and 17): added by the organiser one
-- by one or from a CSV file, approved at once, with "Send QRs now" or "Add only,
-- send later". NULL = the normal way (proof of payment, or complimentary);
-- 'cash' = paid in cash to the organiser. Shown as a separate total on the
-- dashboard and as a column in the guest list export.
ALTER TABLE tickets ADD COLUMN payment TEXT CHECK (payment IN ('cash'));
