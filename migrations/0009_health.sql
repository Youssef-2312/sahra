-- Phase 4, workstream F: unattended health checks with alerts to the site
-- owners, and per-party limits (src/health/, src/limits/). Additive only.

-- The outbox requires a party (outbox.party_id REFERENCES parties(id), and D1
-- enforces foreign keys), but health alerts belong to no party. They are filed
-- under this reserved row, the same id the change log and audit already use for
-- site-level rows. It is disabled and paused (nobody can sign in to it, sign up
-- for it or scan for it; party ids created by people cannot start with "_"), has
-- no staff and no control object, and is left out of the site owner's party
-- list. Its outbox rows are never shown on any party's outbox page. logged_rev 0:
-- the first change-log flush records it in the ledger like any party.
INSERT INTO parties (id, name, capacity, admission_state, created_at, disabled_at, last_action)
  VALUES ('_platform', 'Site messages (not a party)', 0, 'paused', 0, 0, 'platform_reserved')
  ON CONFLICT (id) DO NOTHING;

-- One row ('main') of state for the scheduled checks (src/health/).
--   last_backup_at      Unix ms of the last SUCCESSFUL backup. Written by the
--                       backup job (workstream E):
--                         UPDATE health_state SET last_backup_at = ?, last_backup_note = ? WHERE id = 'main'
--                       NULL = no backup recorded yet (the check shows "not set
--                       up" and does not alert until the first one is recorded).
--   last_backup_note    short free text from the backup job (what, where), shown on the page
--   lease_until         a run in progress (two overlapping runs never both work)
--   last_run_at / last_run_report   the latest run and its counts (JSON)
--   admissions_to       admissions with used_at up to here have been checked
--   audit_seen_id / outbox_seen_at  cursors of the daily write estimate
--   usage_day           UTC day (floor(unix ms / 86,400,000)) of usage_base
--   usage_base          estimated rows written that day, excluding email sends
--   usage_est           usage_base + email sends: the app's estimate for the day,
--                       read by the per-party limits (non-essential work stops at 50%)
--   daily_day           UTC day of the latest daily run (summary, cleanup)
CREATE TABLE health_state (
  id TEXT PRIMARY KEY,
  last_backup_at INTEGER,
  last_backup_note TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_op TEXT,
  last_run_at INTEGER,
  last_run_report TEXT,
  admissions_to INTEGER,
  audit_seen_id INTEGER,
  outbox_seen_at INTEGER,
  usage_day INTEGER NOT NULL DEFAULT 0,
  usage_base INTEGER NOT NULL DEFAULT 0,
  usage_est INTEGER NOT NULL DEFAULT 0,
  daily_day INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;
INSERT INTO health_state (id) VALUES ('main') ON CONFLICT (id) DO NOTHING;

-- One row per check: its current status and when the site owners were last told.
-- At most one alert per problem per 6 hours (alerted_at), and one "resolved"
-- message when it clears. detail is short JSON for the page (never guest data).
CREATE TABLE health_checks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ok', 'problem', 'unknown')),
  summary TEXT NOT NULL,
  detail TEXT,
  since INTEGER NOT NULL,           -- status unchanged since
  checked_at INTEGER NOT NULL,
  alerted_at INTEGER,               -- last problem alert (NULL: none for this problem)
  alert_op TEXT                     -- the run that alerted last (guards its outbox rows)
) STRICT, WITHOUT ROWID;

-- Per-party daily counters for the expensive actions (src/limits/). The cap is
-- checked inside the statement that counts, so two requests at once never both
-- pass it. One row written per counted request; rows older than 8 days are
-- deleted by the daily run.
CREATE TABLE party_usage (
  party_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'signup' | 'resend_link' | 'release' | 'notice' | 'outbox_approve' | 'export'
  day INTEGER NOT NULL,             -- UTC day
  n INTEGER NOT NULL,
  PRIMARY KEY (party_id, kind, day)
) STRICT, WITHOUT ROWID;

-- Health messages for the site owners' Discord channel (optional webhook,
-- secret DISCORD_WEBHOOK_URL). Email through the outbox stays the primary
-- channel; this is extra. A row is added in the same batch that decides the alert
-- (same 6-hour rule), then each health run posts at most 3 due rows. Failed posts
-- (network, 5xx, 429) are retried on later runs until 24 hours after creation,
-- then marked gave_up. Rows older than 8 days (not pending) are deleted daily.
CREATE TABLE health_discord (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  content TEXT NOT NULL,            -- plain text, at most 1,900 characters, no emojis
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'gave_up')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  sent_at INTEGER
) STRICT, WITHOUT ROWID;
