-- Phase 1: parties, staff, invitations, sessions, login attempts, audit.
-- Every change to a party, staff or invite row bumps `rev`. `logged_rev` is the
-- highest rev whose full state is confirmed in the R2 change log. `last_op` is a
-- random id of the request that made the latest change (used to tie audit rows and
-- follow-up statements in the same batch to that change). Times are Unix ms.

CREATE TABLE parties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  max_people_per_ticket INTEGER NOT NULL DEFAULT 1 CHECK (max_people_per_ticket >= 1),
  pause_number INTEGER NOT NULL DEFAULT 0,
  admission_state TEXT NOT NULL DEFAULT 'paused' CHECK (admission_state IN ('open', 'paused', 'reconciling')),
  key_id INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  logged_rev INTEGER NOT NULL DEFAULT 0,
  last_op TEXT,
  last_action TEXT
) STRICT;

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES parties(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'door')),
  google_sub TEXT,
  invited_email TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  disabled_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  logged_rev INTEGER NOT NULL DEFAULT 0,
  last_op TEXT,
  last_action TEXT
) STRICT;
CREATE UNIQUE INDEX staff_party_sub ON staff(party_id, google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX staff_sub ON staff(google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX staff_unlinked_email ON staff(invited_email) WHERE google_sub IS NULL;

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('door', 'google')),
  token_hash TEXT UNIQUE,
  party_id TEXT NOT NULL REFERENCES parties(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'door')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  session_hash TEXT,
  revoked_at INTEGER,
  revoked_by TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  logged_rev INTEGER NOT NULL DEFAULT 0,
  last_op TEXT,
  last_action TEXT,
  CHECK ((kind = 'door' AND token_hash IS NOT NULL) OR (kind = 'google' AND token_hash IS NULL))
) STRICT;
CREATE INDEX invites_staff ON invites(staff_id);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('google', 'door')),
  party_id TEXT NOT NULL REFERENCES parties(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'door')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  invite_id TEXT UNIQUE REFERENCES invites(id)
) STRICT;
CREATE INDEX sessions_staff ON sessions(staff_id);

-- One row per Google sign-in attempt, keyed by SHA-256 of `state`, bound to the
-- browser by `attempt_hash` (SHA-256 of the value in the short-lived Lax cookie).
CREATE TABLE login_attempts (
  state_hash TEXT PRIMARY KEY,
  attempt_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

-- Short-lived, single-use grant to pick a party after a verified Google sign-in
-- when the account is staff at more than one party.
CREATE TABLE login_grants (
  id_hash TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  party_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor_staff_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_rev INTEGER,
  detail TEXT
) STRICT;
