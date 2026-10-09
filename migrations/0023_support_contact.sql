-- Organiser support contact (brainstorm idea 16, owner decision: "A phone or
-- WhatsApp number. required"). Shown to anyone who opens the party page, on the
-- guest's ticket page and on the door scanner, so staff and guests can reach the
-- organiser. Guest requests are refused while support_phone is not set
-- (src/routes/guests.ts). It is the organiser's own choice of number; Sahra does
-- not provide support for parties.
ALTER TABLE parties ADD COLUMN support_phone TEXT;   -- digits, spaces, + - ( ); 6 to 20 digits
ALTER TABLE parties ADD COLUMN support_email TEXT;   -- optional
ALTER TABLE parties ADD COLUMN support_note TEXT;    -- optional, e.g. "Available 6pm to midnight on party day"
