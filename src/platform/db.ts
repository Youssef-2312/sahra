// Site owners, organisers, organiser invitations, platform sessions and
// party creation / disabling (workstream B). Like src/db/index.ts, every rule
// that decides whether a change happens is inside the statement that makes it,
// including "is this platform session still valid for this role".

import { CONFIG } from "../env";
import type { SqlDriver } from "../db/driver";
import { sql, type Sql } from "../db/sql";

/** Party id used for platform-level audit rows, change-log entries and intents. Party ids cannot start with "_". */
export const PLATFORM = "_platform";
/** Active parties a new organiser may have (organisers.party_limit default); a site owner sets 1..MAX_PARTY_LIMIT. */
export const DEFAULT_PARTY_LIMIT = 1;
export const MAX_PARTY_LIMIT = 20;

/** Active (not disabled) parties of an organiser. */
function activeParties(organiserId: Sql | string): Sql {
  const id = typeof organiserId === "string" ? sql`${organiserId}` : organiserId;
  return sql`(SELECT COUNT(*) FROM parties ap WHERE ap.organiser_id = ${id} AND ap.disabled_at IS NULL)`;
}

export type PlatformRole = "site_owner" | "organiser";

export interface PlatformSession {
  google_sub: string;
  expires_at: number;
  site_owner_id: string | null;
  site_owner_name: string | null;
  organiser_id: string | null;
  organiser_name: string | null;
}

/** Platform-level audit row (party_id '_platform'); `from` selects (id, rev) of the changed rows. */
function paudit(now: number, actor: string | null, action: string, entityType: string, from: Sql, detail: string | null = null): Sql {
  return sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
    SELECT ${PLATFORM}, ${now}, ${actor}, ${action}, ${entityType}, id, rev, ${detail} FROM (${from})`;
}

/** Party audit row; `from` selects (party_id, id, rev). */
function audit(now: number, actor: string | null, action: string, entityType: string, from: Sql, detail: string | null = null): Sql {
  return sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
    SELECT party_id, ${now}, ${actor}, ${action}, ${entityType}, id, rev, ${detail} FROM (${from})`;
}

function liveSession(hash: string, now: number): Sql {
  return sql`s.id_hash = ${hash} AND s.revoked_at IS NULL AND s.expires_at > ${now}`;
}

/** True only if the platform session is valid right now and its Google account is an active site owner `ownerId`. */
export function siteOwnerValid(hash: string, ownerId: string, now: number): Sql {
  return sql`EXISTS (SELECT 1 FROM platform_sessions s JOIN platform_admins pa ON pa.google_sub = s.google_sub
    WHERE ${liveSession(hash, now)} AND pa.id = ${ownerId} AND pa.disabled_at IS NULL)`;
}

/** True only if the platform session is valid right now and its Google account is the active organiser `organiserId`. */
export function organiserValid(hash: string, organiserId: string, now: number): Sql {
  return sql`EXISTS (SELECT 1 FROM platform_sessions s JOIN organisers o ON o.google_sub = s.google_sub
    WHERE ${liveSession(hash, now)} AND o.id = ${organiserId} AND o.disabled_at IS NULL)`;
}

/** Read-only hourly cap per Google account, counting platform session rows (no counter writes). */
function underPlatformCap(sub: string, now: number): Sql {
  return sql`(SELECT COUNT(*) FROM platform_sessions cap WHERE cap.google_sub = ${sub} AND cap.created_at > ${now - 3600_000}) < ${CONFIG.maxSessionsPerStaffPerHour}`;
}

function activePrincipal(sub: string): Sql {
  return sql`(EXISTS (SELECT 1 FROM platform_admins WHERE google_sub = ${sub} AND disabled_at IS NULL)
    OR EXISTS (SELECT 1 FROM organisers WHERE google_sub = ${sub} AND disabled_at IS NULL))`;
}

export class PlatformDb {
  constructor(readonly driver: SqlDriver) {}

  // ----------------------------------------------------------------- sessions

  async getSession(hash: string, now: number): Promise<PlatformSession | null> {
    const r = await this.driver.all<PlatformSession>(sql`SELECT s.google_sub, s.expires_at,
        pa.id AS site_owner_id, pa.name AS site_owner_name, o.id AS organiser_id, o.name AS organiser_name
      FROM platform_sessions s
      LEFT JOIN platform_admins pa ON pa.google_sub = s.google_sub AND pa.disabled_at IS NULL
      LEFT JOIN organisers o ON o.google_sub = s.google_sub AND o.disabled_at IS NULL
      WHERE ${liveSession(hash, now)}`);
    const row = r.results[0];
    return row && (row.site_owner_id || row.organiser_id) ? row : null;
  }

  async revokeSession(hash: string, now: number): Promise<void> {
    await this.driver.all(sql`UPDATE platform_sessions SET revoked_at = ${now} WHERE id_hash = ${hash} AND revoked_at IS NULL`);
  }

  /**
   * Links a verified Google account (caller checked canAutoLink) to a pending
   * site owner row and/or a pending organiser invitation with this email, in
   * one transaction. A second sign-in racing on the same invitation finds the
   * row already linked (and the unique index refuses a second active link).
   */
  async link(sub: string, email: string, now: number, op: string): Promise<number> {
    const linkedOrg = sql`SELECT id, rev FROM organisers WHERE google_sub = ${sub} AND last_op = ${op}`;
    const rs = await this.driver.batch([
      sql`UPDATE platform_admins SET google_sub = ${sub}, rev = rev + 1, last_op = ${op}, last_action = 'site_owner_linked'
        WHERE email = ${email} AND google_sub IS NULL AND disabled_at IS NULL AND invite_expires_at > ${now}
          AND NOT EXISTS (SELECT 1 FROM platform_admins x WHERE x.google_sub = ${sub} AND x.disabled_at IS NULL)`,
      sql`UPDATE organisers SET google_sub = ${sub}, rev = rev + 1, last_op = ${op}, last_action = 'organiser_linked'
        WHERE email = ${email} AND google_sub IS NULL AND disabled_at IS NULL
          AND EXISTS (SELECT 1 FROM organiser_invites i WHERE i.organiser_id = organisers.id
                      AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${now})
          AND NOT EXISTS (SELECT 1 FROM organisers x WHERE x.google_sub = ${sub} AND x.disabled_at IS NULL)`,
      sql`UPDATE organiser_invites SET used_at = ${now}, rev = rev + 1, last_op = ${op}, last_action = 'organiser_invite_used'
        WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ${now}
          AND organiser_id IN (SELECT id FROM organisers WHERE google_sub = ${sub} AND last_op = ${op})`,
      paudit(now, null, "site_owner_linked", "platform_admin", sql`SELECT id, rev FROM platform_admins WHERE google_sub = ${sub} AND last_op = ${op}`),
      paudit(now, null, "organiser_linked", "organiser", linkedOrg),
      paudit(now, null, "organiser_invite_used", "organiser_invite", sql`SELECT id, rev FROM organiser_invites WHERE last_op = ${op}
        AND organiser_id IN (SELECT id FROM (${linkedOrg}))`),
    ]);
    return rs[0]!.meta.changes + rs[1]!.meta.changes;
  }

  async hasPendingInvite(email: string, now: number): Promise<boolean> {
    const r = await this.driver.all(sql`SELECT 1 AS x FROM organisers o WHERE o.email = ${email} AND o.google_sub IS NULL AND o.disabled_at IS NULL
        AND EXISTS (SELECT 1 FROM organiser_invites i WHERE i.organiser_id = o.id AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${now})
      UNION ALL SELECT 1 FROM platform_admins pa WHERE pa.email = ${email} AND pa.google_sub IS NULL AND pa.disabled_at IS NULL
        AND pa.invite_expires_at > ${now}
      LIMIT 1`);
    return r.results.length > 0;
  }

  async hasAccess(sub: string): Promise<boolean> {
    const r = await this.driver.all<{ ok: number }>(sql`SELECT ${activePrincipal(sub)} AS ok`);
    return Number(r.results[0]?.ok) === 1;
  }

  /** Creates a platform session only if the account is an active site owner or organiser and under the hourly cap. */
  async createSession(a: { hash: string; sub: string; now: number; expiresAt: number }) {
    const rs = await this.driver.batch([
      sql`INSERT INTO platform_sessions (id_hash, google_sub, created_at, expires_at)
        SELECT ${a.hash}, ${a.sub}, ${a.now}, ${a.expiresAt} WHERE ${activePrincipal(a.sub)} AND ${underPlatformCap(a.sub, a.now)}`,
      sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
        SELECT ${PLATFORM}, ${a.now}, NULL, 'login_platform', 'platform_session', ${a.sub}, NULL, NULL
        FROM platform_sessions WHERE id_hash = ${a.hash}`,
      sql`SELECT ${underPlatformCap(a.sub, a.now)} AS under_cap`,
    ]);
    if (rs[0]!.meta.changes === 1) return "created" as const;
    return (rs[2]!.results[0] as { under_cap: number } | undefined)?.under_cap ? ("rejected" as const) : ("capped" as const);
  }

  // ------------------------------------------------------- site owner: organisers

  async inviteOrganiser(hash: string, ownerId: string, a: {
    organiserId: string; inviteId: string; name: string; email: string; now: number; expiresAt: number; op: string;
  }) {
    const ok = siteOwnerValid(hash, ownerId, a.now);
    const rs = await this.driver.batch([
      sql`INSERT INTO organisers (id, name, email, created_at, created_by, last_op, last_action)
        SELECT ${a.organiserId}, ${a.name}, ${a.email}, ${a.now}, ${ownerId}, ${a.op}, 'organiser_invited'
        WHERE ${ok} AND NOT EXISTS (SELECT 1 FROM organisers x WHERE x.id = ${a.organiserId})
          AND NOT EXISTS (SELECT 1 FROM organisers x WHERE x.email = ${a.email} AND x.disabled_at IS NULL)`,
      sql`INSERT INTO organiser_invites (id, organiser_id, created_by, created_at, expires_at, last_op, last_action)
        SELECT ${a.inviteId}, ${a.organiserId}, ${ownerId}, ${a.now}, ${a.expiresAt}, ${a.op}, 'organiser_invite_created'
        WHERE EXISTS (SELECT 1 FROM organisers WHERE id = ${a.organiserId} AND last_op = ${a.op})
          AND NOT EXISTS (SELECT 1 FROM organiser_invites WHERE id = ${a.inviteId})`,
      paudit(a.now, ownerId, "organiser_invited", "organiser", sql`SELECT id, rev FROM organisers WHERE id = ${a.organiserId} AND last_op = ${a.op}`),
      paudit(a.now, ownerId, "organiser_invite_created", "organiser_invite",
        sql`SELECT id, rev FROM organiser_invites WHERE id = ${a.inviteId} AND last_op = ${a.op}`),
      sql`SELECT o.email, i.id AS invite_id FROM organisers o LEFT JOIN organiser_invites i ON i.id = ${a.inviteId} AND i.organiser_id = o.id
        WHERE o.id = ${a.organiserId}`,
    ]);
    if (rs[0]!.meta.changes === 1) return "created" as const;
    const row = rs[4]!.results[0] as undefined | { email: string; invite_id: string | null };
    if (row && row.email === a.email && row.invite_id) return "already" as const;
    return "rejected" as const;
  }

  /** Disables an organiser: revokes their platform sessions and unused invitations. Their parties are not changed. */
  async disableOrganiser(hash: string, ownerId: string, organiserId: string, now: number, op: string) {
    const ok = siteOwnerValid(hash, ownerId, now);
    const rs = await this.driver.batch([
      sql`UPDATE organisers SET disabled_at = ${now}, disabled_by = ${ownerId}, rev = rev + 1, last_op = ${op}, last_action = 'organiser_disabled'
        WHERE id = ${organiserId} AND disabled_at IS NULL AND ${ok}`,
      // Every platform session of this Google account (a retry also catches any made since).
      sql`UPDATE platform_sessions SET revoked_at = ${now} WHERE revoked_at IS NULL
        AND google_sub = (SELECT google_sub FROM organisers WHERE id = ${organiserId} AND disabled_at IS NOT NULL)`,
      sql`UPDATE organiser_invites SET revoked_at = ${now}, revoked_by = ${ownerId}, rev = rev + 1, last_op = ${op}, last_action = 'organiser_invite_revoked'
        WHERE organiser_id = ${organiserId} AND used_at IS NULL AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM organisers WHERE id = ${organiserId} AND disabled_at IS NOT NULL)`,
      paudit(now, ownerId, "organiser_disabled", "organiser", sql`SELECT id, rev FROM organisers WHERE id = ${organiserId} AND last_op = ${op}`),
      paudit(now, ownerId, "organiser_invite_revoked", "organiser_invite",
        sql`SELECT id, rev FROM organiser_invites WHERE organiser_id = ${organiserId} AND last_op = ${op}`),
      sql`SELECT disabled_at, ${ok} AS ok FROM organisers WHERE id = ${organiserId}`,
    ]);
    const row = rs[5]!.results[0] as undefined | { disabled_at: number | null; ok: number };
    if (!row || Number(row.ok) !== 1) return "rejected" as const;
    if (rs[0]!.meta.changes === 1) return "disabled" as const;
    return row.disabled_at != null ? ("already" as const) : ("rejected" as const);
  }

  async listOrganisers(hash: string, ownerId: string, now: number) {
    const ok = siteOwnerValid(hash, ownerId, now);
    const rs = await this.driver.batch([
      sql`SELECT o.id, o.name, o.email, o.google_sub IS NOT NULL AS linked, o.created_at, o.disabled_at,
o.party_limit, ${activeParties(sql`o.id`)} AS active_parties,
          (SELECT COUNT(*) FROM parties p WHERE p.organiser_id = o.id) AS parties
        FROM organisers o WHERE ${ok} ORDER BY o.created_at`,
      sql`SELECT id, organiser_id, created_at, expires_at, used_at, revoked_at FROM organiser_invites WHERE ${ok} ORDER BY created_at`,
    ]);
    return { organisers: rs[0]!.results, invites: rs[1]!.results };
  }

  /**
   * Per-party counts for the site owner: no guest names, emails, answers or
   * payment data. Reads every ticket, session and outbox row once (GROUP BY);
   * a page opened by hand, not polled.
   */
  async partyCounts(hash: string, ownerId: string, now: number) {
    const ok = siteOwnerValid(hash, ownerId, now);
    const rs = await this.driver.batch([
      sql`SELECT p.id, p.name, p.capacity, p.created_at, p.disabled_at, p.admission_state, p.organiser_id, o.name AS organiser_name,
          (SELECT COUNT(*) FROM staff st WHERE st.party_id = p.id AND st.disabled_at IS NULL) AS staff,
          (SELECT COUNT(*) FROM sessions s WHERE s.party_id = p.id AND s.revoked_at IS NULL AND s.expires_at > ${now}) AS active_sessions
        FROM parties p LEFT JOIN organisers o ON o.id = p.organiser_id WHERE ${ok} ORDER BY p.created_at`,
      sql`SELECT party_id, status, COUNT(*) AS n FROM tickets WHERE ${ok} GROUP BY party_id, status`,
      sql`SELECT party_id, status, COUNT(*) AS n FROM outbox WHERE ${ok} GROUP BY party_id, status`,
    ]);
    const tickets = new Map<string, Record<string, number>>();
    const outbox = new Map<string, Record<string, number>>();
    for (const [rows, into] of [[rs[1]!.results, tickets], [rs[2]!.results, outbox]] as const) {
      for (const r of rows as { party_id: string; status: string; n: number }[]) {
        const m = into.get(r.party_id) ?? {};
        m[r.status] = Number(r.n);
        into.set(r.party_id, m);
      }
    }
    return {
      parties: (rs[0]!.results as { id: string }[]).map((p) => ({ ...p, tickets: tickets.get(p.id) ?? {}, outbox: outbox.get(p.id) ?? {} })),
    };
  }

  // ------------------------------------------------------- site owner: parties

  async partyForDisable(partyId: string) {
    const r = await this.driver.all<{ disabled_at: number | null; pause_number: number }>(
      sql`SELECT disabled_at, pause_number FROM parties WHERE id = ${partyId}`,
    );
    return r.results[0] ?? null;
  }

  /**
   * Main-database half of disabling a party (the control object was paused
   * first): marks it disabled and paused with the control object's
   * pause_number, revokes every session and every unused invitation, audit rows.
   */
  async disableParty(hash: string, ownerId: string, partyId: string, pauseNumber: number, now: number, op: string) {
    const ok = siteOwnerValid(hash, ownerId, now);
    const disabled = sql`EXISTS (SELECT 1 FROM parties WHERE id = ${partyId} AND disabled_at IS NOT NULL)`;
    const rs = await this.driver.batch([
      sql`UPDATE parties SET disabled_at = ${now}, admission_state = 'paused', pause_number = ${pauseNumber},
          rev = rev + 1, last_op = ${op}, last_action = 'party_disabled'
        WHERE id = ${partyId} AND disabled_at IS NULL AND ${ok}`,
      // Run on a retry too (a session made between two attempts is caught).
      sql`UPDATE sessions SET revoked_at = ${now} WHERE party_id = ${partyId} AND revoked_at IS NULL AND ${disabled} AND ${ok}`,
      sql`UPDATE invites SET revoked_at = ${now}, revoked_by = ${ownerId}, rev = rev + 1, last_op = ${op}, last_action = 'invite_revoked'
        WHERE party_id = ${partyId} AND used_at IS NULL AND revoked_at IS NULL AND ${disabled} AND ${ok}`,
      audit(now, ownerId, "party_disabled", "party", sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${partyId} AND last_op = ${op}`,
        `site owner; pause_number ${pauseNumber}`),
      audit(now, ownerId, "invite_revoked", "invite", sql`SELECT party_id, id, rev FROM invites WHERE party_id = ${partyId} AND last_op = ${op}`,
        "party disabled"),
      sql`SELECT disabled_at, ${ok} AS ok FROM parties WHERE id = ${partyId}`,
    ]);
    const row = rs[5]!.results[0] as undefined | { disabled_at: number | null; ok: number };
    if (!row || Number(row.ok) !== 1) return "rejected" as const;
    if (rs[0]!.meta.changes === 1) return "disabled" as const;
    return row.disabled_at != null ? ("already" as const) : ("rejected" as const);
  }

  /** Re-enables a disabled party. It stays paused (admission and control object); its owners reopen admission. */
  async enableParty(hash: string, ownerId: string, partyId: string, now: number, op: string) {
    const ok = siteOwnerValid(hash, ownerId, now);
    const rs = await this.driver.batch([
      sql`UPDATE parties SET disabled_at = NULL, rev = rev + 1, last_op = ${op}, last_action = 'party_enabled'
        WHERE id = ${partyId} AND disabled_at IS NOT NULL AND ${ok}`,
      audit(now, ownerId, "party_enabled", "party", sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${partyId} AND last_op = ${op}`,
        "site owner; admission stays paused"),
      sql`SELECT disabled_at, ${ok} AS ok FROM parties WHERE id = ${partyId}`,
    ]);
    const row = rs[2]!.results[0] as undefined | { disabled_at: number | null; ok: number };
    if (!row) return "not_found" as const;
    if (Number(row.ok) !== 1) return "rejected" as const;
    if (rs[0]!.meta.changes === 1) return "enabled" as const;
    return row.disabled_at == null ? ("already" as const) : ("rejected" as const);
  }

  // ------------------------------------------------------- site owner: limits, site owners

  /** Sets how many active parties an organiser may have (1..MAX_PARTY_LIMIT; the column CHECK enforces it too). */
  async setPartyLimit(hash: string, ownerId: string, organiserId: string, limit: number, now: number, op: string) {
    const ok = siteOwnerValid(hash, ownerId, now);
    const rs = await this.driver.batch([
      sql`UPDATE organisers SET party_limit = ${limit}, rev = rev + 1, last_op = ${op}, last_action = 'party_limit_changed'
        WHERE id = ${organiserId} AND party_limit != ${limit} AND ${ok}`,
      paudit(now, ownerId, "party_limit_changed", "organiser", sql`SELECT id, rev FROM organisers WHERE id = ${organiserId} AND last_op = ${op}`,
        String(limit)),
      sql`SELECT party_limit, ${ok} AS ok FROM organisers WHERE id = ${organiserId}`,
    ]);
    const row = rs[2]!.results[0] as undefined | { party_limit: number; ok: number };
    if (!row) return "not_found" as const;
    if (Number(row.ok) !== 1) return "rejected" as const;
    if (rs[0]!.meta.changes === 1) return "changed" as const;
    return row.party_limit === limit ? ("already" as const) : ("rejected" as const);
  }

  async listSiteOwners(hash: string, ownerId: string, now: number) {
    const ok = siteOwnerValid(hash, ownerId, now);
    const r = await this.driver.all(sql`SELECT id, name, email, google_sub IS NOT NULL AS linked, invite_expires_at, created_at, disabled_at
      FROM platform_admins WHERE ${ok} ORDER BY created_at`);
    return { site_owners: r.results };
  }

  /**
   * Removes another site owner: never the caller, never the last active one
   * (both inside the statement), and revokes every platform session of that
   * Google account. Two site owners removing each other at once: the second
   * statement finds its own session no longer valid.
   */
  async removeSiteOwner(hash: string, ownerId: string, targetId: string, now: number, op: string) {
    const ok = siteOwnerValid(hash, ownerId, now);
    const rs = await this.driver.batch([
      sql`UPDATE platform_admins SET disabled_at = ${now}, disabled_by = ${ownerId}, rev = rev + 1, last_op = ${op}, last_action = 'site_owner_removed'
        WHERE id = ${targetId} AND id != ${ownerId} AND disabled_at IS NULL AND ${ok}
          AND (SELECT COUNT(*) FROM platform_admins o WHERE o.disabled_at IS NULL AND o.id != ${targetId}) >= 1`,
      sql`UPDATE platform_sessions SET revoked_at = ${now} WHERE revoked_at IS NULL
        AND google_sub = (SELECT google_sub FROM platform_admins WHERE id = ${targetId} AND disabled_at IS NOT NULL)`,
      paudit(now, ownerId, "site_owner_removed", "platform_admin", sql`SELECT id, rev FROM platform_admins WHERE id = ${targetId} AND last_op = ${op}`),
      sql`SELECT disabled_at, ${ok} AS ok FROM platform_admins WHERE id = ${targetId}`,
    ]);
    const row = rs[3]!.results[0] as undefined | { disabled_at: number | null; ok: number };
    if (!row) return "not_found" as const;
    if (Number(row.ok) !== 1 || targetId === ownerId) return "rejected" as const;
    if (rs[0]!.meta.changes === 1) return "removed" as const;
    return row.disabled_at != null ? ("already" as const) : ("rejected" as const);
  }

  // ------------------------------------------------------- organiser: parties

  /**
   * Creates a party and makes the organiser its owner (staff row linked to their
   * Google account) in ONE batch, with audit rows. The organiser check and the
   * per-organiser limit are inside the INSERT.
   */
  async createParty(hash: string, organiserId: string, a: { partyId: string; name: string; capacity: number; staffId: string; now: number; op: string }) {
    const ok = organiserValid(hash, organiserId, a.now);
    const rs = await this.driver.batch([
      sql`INSERT INTO parties (id, name, capacity, created_at, organiser_id, last_op, last_action)
        SELECT ${a.partyId}, ${a.name}, ${a.capacity}, ${a.now}, ${organiserId}, ${a.op}, 'party_created'
        WHERE ${ok} AND NOT EXISTS (SELECT 1 FROM parties WHERE id = ${a.partyId})
          AND ${activeParties(organiserId)} < (SELECT party_limit FROM organisers WHERE id = ${organiserId})`,
      sql`INSERT INTO staff (id, party_id, name, role, google_sub, invited_email, created_at, created_by, last_op, last_action)
        SELECT ${a.staffId}, ${a.partyId}, o.name, 'owner', o.google_sub, o.email, ${a.now}, ${organiserId}, ${a.op}, 'staff_added'
        FROM organisers o WHERE o.id = ${organiserId}
          AND EXISTS (SELECT 1 FROM parties WHERE id = ${a.partyId} AND last_op = ${a.op})`,
      audit(a.now, null, "party_created", "party", sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${a.partyId} AND last_op = ${a.op}`,
        `organiser ${organiserId}`),
      audit(a.now, null, "staff_added", "staff", sql`SELECT party_id, id, rev FROM staff WHERE id = ${a.staffId} AND last_op = ${a.op}`,
        "organiser is owner"),
      sql`SELECT p.organiser_id, p.name, ${ok} AS ok,
          ${activeParties(organiserId)} AS n, (SELECT party_limit FROM organisers WHERE id = ${organiserId}) AS party_limit
        FROM (SELECT 1) LEFT JOIN parties p ON p.id = ${a.partyId}`,
    ]);
    if (rs[0]!.meta.changes === 1) return "created" as const;
    const row = rs[4]!.results[0] as { organiser_id: string | null; name: string | null; ok: number; n: number; party_limit: number };
    if (Number(row.ok) !== 1) return "forbidden" as const;
    if (row.organiser_id === organiserId && row.name === a.name) return "already" as const;
    if (row.name != null) return "id_taken" as const;
    return Number(row.n) >= Number(row.party_limit) ? ("limit" as const) : ("rejected" as const);
  }

  async myParties(hash: string, organiserId: string, now: number) {
    const ok = organiserValid(hash, organiserId, now);
    const r = await this.driver.all(sql`SELECT id, name, capacity, created_at, disabled_at, admission_state
      FROM parties WHERE organiser_id = ${organiserId} AND ${ok} ORDER BY created_at`);
    return r.results;
  }
}
