-- Optional public label. NULL hides it; all / minimum:N / under:N are explicit.
-- No existing party is assigned a restriction by this migration.
ALTER TABLE parties ADD COLUMN age_rating TEXT;
