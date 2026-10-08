-- Phase 4 shared base: the email outbox (brief section 10). Rows are added in the
-- same batch as the change that causes them (release, resend link, notices).
-- Sending is a separate workstream (a once-a-minute cron, rate limited); until the
-- owner has chosen and approved a provider, nothing is ever sent.
--
-- status:
--   awaiting_approval  needs a party owner/admin's approval first (e.g. "message all guests")
--   queued             ready to send at next_attempt_at
--   sending            claimed by a sender run (claim_op), result not yet known
--   sent | failed      final (failed after the retry limit)
--   cancelled          withdrawn before sending
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES parties(id),
  kind TEXT NOT NULL,               -- 'ticket_released' | 'ticket_link' | 'party_notice' | ...
  to_email TEXT NOT NULL,
  ticket_id TEXT,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,          -- plain text; no emojis
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'queued', 'sending', 'sent', 'failed', 'cancelled')),
  created_at INTEGER NOT NULL,
  created_by TEXT,
  approved_at INTEGER,
  approved_by TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  claim_op TEXT,
  last_error TEXT,
  sent_at INTEGER,
  provider TEXT
) STRICT, WITHOUT ROWID;
