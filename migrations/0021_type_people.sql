-- Group and single tickets (owner request: "one for group and one for normal").
-- Additive only.
--
-- A ticket type can set how many people one of its tickets admits: min_people and
-- max_people (1 to 50; NULL = the party's own rule: 1 up to
-- parties.max_people_per_ticket). For example "Normal" 1 to 1, "Group" 2 to 6.
-- The price stays per person. Checked inside the sign-up and issue statements
-- (src/guests/types.ts peopleOk), as every other rule.
ALTER TABLE ticket_types ADD COLUMN min_people INTEGER CHECK (min_people IS NULL OR min_people BETWEEN 1 AND 50);
ALTER TABLE ticket_types ADD COLUMN max_people INTEGER CHECK (max_people IS NULL OR max_people BETWEEN 1 AND 50);
