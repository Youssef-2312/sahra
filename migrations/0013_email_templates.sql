-- Owner-editable guest emails (owner request). NULL = Sahra's default text.
-- Placeholders, filled per guest when the email is created:
--   ticket email: {guest_name} {party_name} {link} {people_note}   ({link} required)
--   link email:   {party_name} {links}                             ({links} required)
-- Plain text, no emojis (rule 6), validated in src/party/input.ts; logged with the
-- party (change log), like every other party detail.
ALTER TABLE parties ADD COLUMN email_ticket_subject TEXT;
ALTER TABLE parties ADD COLUMN email_ticket_body TEXT;
ALTER TABLE parties ADD COLUMN email_link_subject TEXT;
ALTER TABLE parties ADD COLUMN email_link_body TEXT;
