-- Phase 4, workstream D: sending the email outbox (src/email/, src/routes/outbox.ts).
--
-- outbox_due: the once-a-minute sender finds due rows ("queued" or a stuck
-- "sending" past its claim deadline, both by next_attempt_at) without scanning
-- the table. Costs one extra index write on insert and on each status change.
CREATE INDEX outbox_due ON outbox(status, next_attempt_at);
-- outbox_party: the party's outbox page, newest first, paged. Written on insert
-- only (party_id, created_at and id never change).
CREATE INDEX outbox_party ON outbox(party_id, created_at, id);

-- Who withdrew an unsent email, and when.
ALTER TABLE outbox ADD COLUMN cancelled_at INTEGER;
ALTER TABLE outbox ADD COLUMN cancelled_by TEXT;

-- Sends per provider per UTC hour, so the sender can keep a rolling 24-hour cap
-- (Gmail's limit is a rolling window) and a per-minute cap. One row per provider
-- per hour that had sends; one row written per email.
CREATE TABLE email_quota (
  provider TEXT NOT NULL,          -- 'gmail' | 'brevo'
  hour INTEGER NOT NULL,           -- floor(unix ms / 3,600,000)
  sent INTEGER NOT NULL DEFAULT 0, -- attempts that reached the provider this hour
  minute INTEGER NOT NULL DEFAULT 0,      -- floor(unix ms / 60,000) of the latest send
  minute_sent INTEGER NOT NULL DEFAULT 0, -- sends in that minute
  PRIMARY KEY (provider, hour)
) STRICT, WITHOUT ROWID;
