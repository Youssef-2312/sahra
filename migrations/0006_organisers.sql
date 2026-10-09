-- Phase 4, workstream B: site owners, organisers by invitation, platform
-- sessions, disabling a party.
--
-- Site owners and organisers are people identified by a Google account
-- (`google_sub`), linked on first sign-in by the same auto-link rules as party
-- staff (verified Gmail, or Workspace with a matching hd; afterwards by sub only).
-- They are logged entities like parties/staff/invites: every change bumps `rev`,
-- sets `last_op`/`last_action`, writes an audit row (party_id '_platform') and is
-- confirmed in the change log (ledger, party_id '_platform') before the user is
-- told it worked. Times are Unix ms. Additive only.

-- Site owners (the table keeps its first name, platform_admins). A row is created by the owner's bootstrap step
-- (`node scripts/ops.mjs create-site-owner`) with an email and no Google
-- account yet; the first sign-in with that (auto-linkable) address before
-- `invite_expires_at` links it.
CREATE TABLE platform_admins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,              -- normalized (src/auth/google.ts normalizeEmail)
  google_sub TEXT,
  invite_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  disabled_at INTEGER,              -- removed (by another site owner)
  disabled_by TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  logged_rev INTEGER NOT NULL DEFAULT 0,
  last_op TEXT,
  last_action TEXT
) STRICT;
-- One active site owner row per Google account (also the sign-in lookup by sub).
CREATE UNIQUE INDEX platform_admins_sub ON platform_admins(google_sub) WHERE google_sub IS NOT NULL AND disabled_at IS NULL;

CREATE TABLE organisers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,              -- normalized
  google_sub TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,                  -- site owner id
  disabled_at INTEGER,
  disabled_by TEXT,
  -- Active (not disabled) parties this organiser may have; a site owner changes it.
  party_limit INTEGER NOT NULL DEFAULT 1 CHECK (party_limit BETWEEN 1 AND 20),
  rev INTEGER NOT NULL DEFAULT 1,
  logged_rev INTEGER NOT NULL DEFAULT 0,
  last_op TEXT,
  last_action TEXT
) STRICT;
-- One active organiser row per Google account: two sign-ins racing on the same
-- invitation cannot both link (the link statement also checks this itself).
CREATE UNIQUE INDEX organisers_sub ON organisers(google_sub) WHERE google_sub IS NOT NULL AND disabled_at IS NULL;
CREATE INDEX organisers_unlinked_email ON organisers(email) WHERE google_sub IS NULL;

-- Organiser invitations. A new table because `invites.kind` has a CHECK that an
-- additive migration cannot widen, and `invites.party_id`/`staff_id` are NOT NULL.
CREATE TABLE organiser_invites (
  id TEXT PRIMARY KEY,
  organiser_id TEXT NOT NULL REFERENCES organisers(id),
  created_by TEXT NOT NULL,         -- site owner id
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  logged_rev INTEGER NOT NULL DEFAULT 0,
  last_op TEXT,
  last_action TEXT
) STRICT;
CREATE INDEX organiser_invites_organiser ON organiser_invites(organiser_id);

-- Platform sessions (site owner and organiser pages). A separate table because
-- `sessions.party_id` and `sessions.staff_id` are NOT NULL with foreign keys, and
-- because keeping them apart means a party staff token can never be found by a
-- platform route and the other way round (separate cookie as well). Stored as
-- SHA-256 of the 256-bit token. A session belongs to a Google account; what it
-- may do is decided on every request (and inside every write statement) from the
-- active platform_admins / organisers rows with that sub. Written rarely (one row
-- per sign-in), so a plain table; the sub index serves the hourly cap count and
-- revocation.
CREATE TABLE platform_sessions (
  id_hash TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX platform_sessions_sub ON platform_sessions(google_sub, created_at);

-- Disabling a party (site owner). NULL = active. Who created it (organiser),
-- for the per-organiser party limit; NULL for parties made by the operator script.
ALTER TABLE parties ADD COLUMN disabled_at INTEGER;
ALTER TABLE parties ADD COLUMN organiser_id TEXT;
