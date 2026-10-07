// All database access for Sahra. Every rule that decides whether a change is
// allowed is written into the SQL conditions of the statement that makes the
// change, including session validity: D1 batches are transactions, but a
// statement that matches no rows is not an error and does not roll anything
// back, so a rule checked only in Worker code before the batch would not hold.

import type { SqlDriver } from "./driver";
import { inList, sql, type Sql } from "./sql";
import { CONFIG } from "../env";

/**
 * True while the staff member has created fewer than the hourly cap of sessions.
 * Read-only: it counts existing session rows (indexed by staff_id); nothing is
 * written to keep a counter.
 */
function underSessionCap(staffId: Sql | string, now: number): Sql {
  const id = typeof staffId === "string" ? sql`${staffId}` : staffId;
  return sql`(SELECT COUNT(*) FROM sessions cap WHERE cap.staff_id = ${id} AND cap.created_at > ${now - 3600_000}) < ${CONFIG.maxSessionsPerStaffPerHour}`;
}

export type Role = "owner" | "admin" | "door";
export const ROLES: readonly Role[] = ["owner", "admin", "door"];

export interface SessionRef {
  hash: string;
  partyId: string;
}

export interface SessionInfo {
  party_id: string;
  party_name: string;
  staff_id: string;
  staff_name: string;
  role: Role;
  kind: "google" | "door";
  expires_at: number;
}

/**
 * True only if, at the moment the statement runs: the session exists, is not
 * revoked or expired, belongs to `partyId`, its staff member is not disabled,
 * still has the same role the session was issued for, and that role is allowed.
 */
export function sessionValid(sess: SessionRef, roles: readonly Role[], now: number): Sql {
  return sql`EXISTS (SELECT 1 FROM sessions s JOIN staff a ON a.id = s.staff_id
    WHERE s.id_hash = ${sess.hash} AND s.party_id = ${sess.partyId} AND a.party_id = s.party_id
      AND s.revoked_at IS NULL AND s.expires_at > ${now}
      AND a.disabled_at IS NULL AND a.role = s.role AND s.role IN (${inList(roles)}))`;
}

export function audit(
  now: number,
  actor: string | null,
  action: string,
  entityType: "staff" | "invite" | "party" | "session" | "ticket",
  from: Sql,
  detail: string | null = null,
): Sql {
  // `from` selects (party_id, id, rev) of the changed rows.
  return sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
    SELECT party_id, ${now}, ${actor}, ${action}, ${entityType}, id, rev, ${detail} FROM (${from})`;
}

export type LogEntity = "party" | "staff" | "invite" | "ticket";
export interface UnloggedRow {
  entity: LogEntity;
  id: string;
  party_id: string;
  rev: number;
  state: Record<string, unknown>;
}

export class Db {
  constructor(readonly driver: SqlDriver) {}

  private async first<T>(q: Sql): Promise<T | null> {
    const r = await this.driver.all<T>(q);
    return r.results[0] ?? null;
  }

  // ----------------------------------------------------------------- sessions

  async getSession(hash: string, now: number): Promise<SessionInfo | null> {
    return this.first<SessionInfo>(sql`SELECT s.party_id, p.name AS party_name, s.staff_id, a.name AS staff_name,
        s.role, s.kind, s.expires_at
      FROM sessions s JOIN staff a ON a.id = s.staff_id JOIN parties p ON p.id = s.party_id
      WHERE s.id_hash = ${hash} AND a.party_id = s.party_id
        AND s.revoked_at IS NULL AND s.expires_at > ${now} AND a.disabled_at IS NULL AND a.role = s.role`);
  }

  async revokeSession(hash: string, now: number): Promise<void> {
    await this.driver.all(sql`UPDATE sessions SET revoked_at = ${now} WHERE id_hash = ${hash} AND revoked_at IS NULL`);
  }

  // ------------------------------------------------------------ Google sign-in

  /**
   * Links every pending Google invitation for this (normalized) email to the
   * Google account, in one transaction. The caller has already checked that
   * the token allows auto-linking (verified Gmail address or Workspace hd).
   */
  async linkGoogleInvites(sub: string, email: string, now: number, op: string): Promise<number> {
    const linked = sql`SELECT party_id, id, rev FROM staff WHERE google_sub = ${sub} AND last_op = ${op}`;
    const usedInvites = sql`SELECT party_id, id, rev FROM invites WHERE last_op = ${op}
      AND staff_id IN (SELECT id FROM staff WHERE google_sub = ${sub} AND last_op = ${op})`;
    const rs = await this.driver.batch([
      sql`UPDATE staff SET google_sub = ${sub}, rev = rev + 1, last_op = ${op}, last_action = 'staff_linked'
        WHERE invited_email = ${email} AND google_sub IS NULL AND disabled_at IS NULL
          AND EXISTS (SELECT 1 FROM invites i WHERE i.staff_id = staff.id AND i.party_id = staff.party_id AND i.kind = 'google'
                      AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${now})
          AND NOT EXISTS (SELECT 1 FROM staff s2 WHERE s2.party_id = staff.party_id AND s2.google_sub = ${sub})`,
      sql`UPDATE invites SET used_at = ${now}, rev = rev + 1, last_op = ${op}, last_action = 'invite_used'
        WHERE kind = 'google' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${now}
          AND staff_id IN (SELECT id FROM staff WHERE google_sub = ${sub} AND last_op = ${op})`,
      audit(now, null, "staff_linked", "staff", linked),
      audit(now, null, "invite_used", "invite", usedInvites),
    ]);
    return rs[0]!.meta.changes;
  }

  async hasPendingGoogleInvite(email: string, now: number): Promise<boolean> {
    const r = await this.first(sql`SELECT 1 AS x FROM staff st WHERE st.invited_email = ${email} AND st.google_sub IS NULL
        AND st.disabled_at IS NULL AND EXISTS (SELECT 1 FROM invites i WHERE i.staff_id = st.id AND i.kind = 'google'
          AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${now}) LIMIT 1`);
    return r !== null;
  }

  async activeStaffForSub(sub: string) {
    const r = await this.driver.all<{ staff_id: string; party_id: string; party_name: string; role: Role; name: string }>(
      sql`SELECT st.id AS staff_id, st.party_id, p.name AS party_name, st.role, st.name
        FROM staff st JOIN parties p ON p.id = st.party_id
        WHERE st.google_sub = ${sub} AND st.disabled_at IS NULL AND st.role IN ('owner', 'admin')
        ORDER BY p.name`,
    );
    return r.results;
  }

  /** Creates a session only if the staff row is still linked to this Google account and active. */
  /**
   * Creates a session only if the staff row is still linked to this Google account
   * and active, and the person is under the hourly session cap.
   */
  async createGoogleSession(a: { hash: string; staffId: string; partyId: string; sub: string; now: number; expiresAt: number }) {
    const rs = await this.driver.batch([
      sql`INSERT INTO sessions (id_hash, kind, party_id, staff_id, role, created_at, expires_at)
        SELECT ${a.hash}, 'google', party_id, id, role, ${a.now}, ${a.expiresAt} FROM staff
        WHERE id = ${a.staffId} AND party_id = ${a.partyId} AND google_sub = ${a.sub} AND disabled_at IS NULL
          AND role IN ('owner', 'admin') AND ${underSessionCap(a.staffId, a.now)}`,
      sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
        SELECT party_id, ${a.now}, staff_id, 'login_google', 'staff', staff_id, NULL, NULL FROM sessions WHERE id_hash = ${a.hash}`,
      sql`SELECT ${underSessionCap(a.staffId, a.now)} AS under_cap`,
    ]);
    if (rs[0]!.meta.changes === 1) return "created" as const;
    return (rs[2]!.results[0] as { under_cap: number } | undefined)?.under_cap ? ("rejected" as const) : ("capped" as const);
  }

  // -------------------------------------------------------- door invitations

  /**
   * Consumes a door invitation and creates its session in one transaction.
   * The session token is chosen by the browser, so a retry with the same value
   * can be recognized (the invite stores the session hash) and answered again.
   */
  async consumeDoorInvite(a: { tokenHash: string; sessionHash: string; now: number; expiresAt: number; op: string }) {
    const rs = await this.driver.batch([
      sql`UPDATE invites SET used_at = ${a.now}, session_hash = ${a.sessionHash}, rev = rev + 1,
          last_op = ${a.op}, last_action = 'invite_used'
        WHERE token_hash = ${a.tokenHash} AND kind = 'door' AND used_at IS NULL AND revoked_at IS NULL
          AND expires_at > ${a.now}
          AND EXISTS (SELECT 1 FROM staff st WHERE st.id = invites.staff_id AND st.party_id = invites.party_id
                      AND st.disabled_at IS NULL AND st.role = invites.role)
          AND ${underSessionCap(sql`invites.staff_id`, a.now)}`,
      sql`INSERT INTO sessions (id_hash, kind, party_id, staff_id, role, created_at, expires_at, invite_id)
        SELECT ${a.sessionHash}, 'door', party_id, staff_id, role, ${a.now}, ${a.expiresAt}, id FROM invites
        WHERE token_hash = ${a.tokenHash} AND last_op = ${a.op}`,
      audit(a.now, null, "invite_used", "invite",
        sql`SELECT party_id, id, rev FROM invites WHERE token_hash = ${a.tokenHash} AND last_op = ${a.op}`),
      sql`SELECT i.id, i.party_id, i.staff_id, i.used_at, i.revoked_at, i.expires_at, i.session_hash, i.last_op,
          s.id_hash AS s_hash, s.revoked_at AS s_revoked_at, s.expires_at AS s_expires_at,
          st.disabled_at AS staff_disabled_at, st.name AS staff_name,
          ${underSessionCap(sql`i.staff_id`, a.now)} AS under_cap
        FROM invites i LEFT JOIN sessions s ON s.invite_id = i.id LEFT JOIN staff st ON st.id = i.staff_id
        WHERE i.token_hash = ${a.tokenHash} AND i.kind = 'door'`,
    ]);
    return (rs[3]!.results[0] ?? null) as null | {
      id: string;
      party_id: string;
      staff_id: string;
      used_at: number | null;
      revoked_at: number | null;
      expires_at: number;
      session_hash: string | null;
      last_op: string | null;
      s_hash: string | null;
      s_revoked_at: number | null;
      s_expires_at: number | null;
      staff_disabled_at: number | null;
      staff_name: string;
      under_cap: number;
    };
  }

  // ------------------------------------------------------- staff management
  // All of these are owner-only; the owner check is inside each statement.

  async createGoogleInvite(sess: SessionRef, actor: string, a: {
    staffId: string; inviteId: string; name: string; email: string; role: "owner" | "admin"; now: number; expiresAt: number; op: string;
  }) {
    const ok = sessionValid(sess, ["owner"], a.now);
    const p = sess.partyId;
    const rs = await this.driver.batch([
      sql`INSERT INTO staff (id, party_id, name, role, invited_email, created_at, created_by, last_op, last_action)
        SELECT ${a.staffId}, ${p}, ${a.name}, ${a.role}, ${a.email}, ${a.now}, ${actor}, ${a.op}, 'staff_added'
        WHERE ${ok}
          AND NOT EXISTS (SELECT 1 FROM staff x WHERE x.id = ${a.staffId})
          AND NOT EXISTS (SELECT 1 FROM staff x WHERE x.party_id = ${p} AND x.invited_email = ${a.email} AND x.disabled_at IS NULL)`,
      sql`INSERT INTO invites (id, kind, party_id, staff_id, role, created_by, created_at, expires_at, last_op, last_action)
        SELECT ${a.inviteId}, 'google', ${p}, ${a.staffId}, ${a.role}, ${actor}, ${a.now}, ${a.expiresAt}, ${a.op}, 'invite_created'
        WHERE EXISTS (SELECT 1 FROM staff WHERE id = ${a.staffId} AND last_op = ${a.op})
          AND NOT EXISTS (SELECT 1 FROM invites WHERE id = ${a.inviteId})`,
      audit(a.now, actor, "staff_added", "staff", sql`SELECT party_id, id, rev FROM staff WHERE id = ${a.staffId} AND last_op = ${a.op}`),
      audit(a.now, actor, "invite_created", "invite", sql`SELECT party_id, id, rev FROM invites WHERE id = ${a.inviteId} AND last_op = ${a.op}`),
      sql`SELECT st.id, st.party_id, st.invited_email, st.role, i.id AS invite_id, i.party_id AS invite_party
        FROM staff st LEFT JOIN invites i ON i.id = ${a.inviteId} AND i.staff_id = st.id WHERE st.id = ${a.staffId}`,
    ]);
    const row = rs[4]!.results[0] as undefined | { party_id: string; invited_email: string; role: string; invite_id: string | null };
    if (rs[0]!.meta.changes === 1) return "created" as const;
    if (row && row.party_id === p && row.invited_email === a.email && row.role === a.role && row.invite_id) return "already" as const;
    return "rejected" as const;
  }

  async createDoorInvite(sess: SessionRef, actor: string, a: {
    staffId: string; inviteId: string; name: string | null; tokenHash: string; now: number; expiresAt: number; op: string;
  }) {
    const ok = sessionValid(sess, ["owner"], a.now);
    const p = sess.partyId;
    const fresh = sql`NOT EXISTS (SELECT 1 FROM invites WHERE id = ${a.inviteId})`;
    const rs = await this.driver.batch([
      // New door staff member, unless re-inviting an existing one.
      sql`INSERT INTO staff (id, party_id, name, role, created_at, created_by, last_op, last_action)
        SELECT ${a.staffId}, ${p}, ${a.name}, 'door', ${a.now}, ${actor}, ${a.op}, 'staff_added'
        WHERE ${a.name} IS NOT NULL AND ${ok} AND ${fresh} AND NOT EXISTS (SELECT 1 FROM staff WHERE id = ${a.staffId})`,
      // A new invitation replaces any unused one for the same person.
      sql`UPDATE invites SET revoked_at = ${a.now}, revoked_by = ${actor}, rev = rev + 1, last_op = ${a.op}, last_action = 'invite_revoked'
        WHERE staff_id = ${a.staffId} AND party_id = ${p} AND kind = 'door' AND used_at IS NULL AND revoked_at IS NULL
          AND ${ok} AND ${fresh}`,
      sql`INSERT INTO invites (id, kind, token_hash, party_id, staff_id, role, created_by, created_at, expires_at, last_op, last_action)
        SELECT ${a.inviteId}, 'door', ${a.tokenHash}, ${p}, ${a.staffId}, 'door', ${actor}, ${a.now}, ${a.expiresAt}, ${a.op}, 'invite_created'
        WHERE ${ok} AND ${fresh}
          AND EXISTS (SELECT 1 FROM staff WHERE id = ${a.staffId} AND party_id = ${p} AND role = 'door' AND disabled_at IS NULL)`,
      audit(a.now, actor, "staff_added", "staff", sql`SELECT party_id, id, rev FROM staff WHERE id = ${a.staffId} AND last_op = ${a.op}`),
      audit(a.now, actor, "invite_revoked", "invite",
        sql`SELECT party_id, id, rev FROM invites WHERE staff_id = ${a.staffId} AND last_op = ${a.op} AND last_action = 'invite_revoked'`),
      audit(a.now, actor, "invite_created", "invite", sql`SELECT party_id, id, rev FROM invites WHERE id = ${a.inviteId} AND last_op = ${a.op}`),
      sql`SELECT party_id, staff_id, token_hash FROM invites WHERE id = ${a.inviteId}`,
    ]);
    const row = rs[6]!.results[0] as undefined | { party_id: string; staff_id: string; token_hash: string };
    if (row && row.party_id === p && row.staff_id === a.staffId && row.token_hash === a.tokenHash) {
      return rs[2]!.meta.changes === 1 ? ("created" as const) : ("already" as const);
    }
    return "rejected" as const;
  }

  /**
   * STAGING ONLY (src/routes/testing.ts): a new door staff member plus invitation,
   * created by any staff session of the party (not only owners).
   */
  async createTestDoorInvite(sess: SessionRef, actor: string, a: {
    staffId: string; inviteId: string; name: string; tokenHash: string; now: number; expiresAt: number; op: string;
  }) {
    const ok = sessionValid(sess, ["owner", "admin", "door"], a.now);
    const p = sess.partyId;
    const rs = await this.driver.batch([
      sql`INSERT INTO staff (id, party_id, name, role, created_at, created_by, last_op, last_action)
        SELECT ${a.staffId}, ${p}, ${a.name}, 'door', ${a.now}, ${actor}, ${a.op}, 'staff_added' WHERE ${ok}`,
      sql`INSERT INTO invites (id, kind, token_hash, party_id, staff_id, role, created_by, created_at, expires_at, last_op, last_action)
        SELECT ${a.inviteId}, 'door', ${a.tokenHash}, ${p}, ${a.staffId}, 'door', ${actor}, ${a.now}, ${a.expiresAt}, ${a.op}, 'invite_created'
        WHERE EXISTS (SELECT 1 FROM staff WHERE id = ${a.staffId} AND last_op = ${a.op})`,
      audit(a.now, actor, "staff_added", "staff", sql`SELECT party_id, id, rev FROM staff WHERE id = ${a.staffId} AND last_op = ${a.op}`, "test"),
      audit(a.now, actor, "invite_created", "invite", sql`SELECT party_id, id, rev FROM invites WHERE id = ${a.inviteId} AND last_op = ${a.op}`, "test"),
    ]);
    return rs[1]!.meta.changes === 1;
  }

  /** Revokes an invitation and the session created from it. Idempotent. */
  async revokeInvite(sess: SessionRef, actor: string, inviteId: string, now: number, op: string) {
    const ok = sessionValid(sess, ["owner"], now);
    const p = sess.partyId;
    const rs = await this.driver.batch([
      sql`UPDATE invites SET revoked_at = ${now}, revoked_by = ${actor}, rev = rev + 1, last_op = ${op}, last_action = 'invite_revoked'
        WHERE id = ${inviteId} AND party_id = ${p} AND revoked_at IS NULL AND (kind = 'door' OR used_at IS NULL) AND ${ok}`,
      sql`UPDATE sessions SET revoked_at = ${now} WHERE invite_id = ${inviteId} AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM invites WHERE id = ${inviteId} AND party_id = ${p} AND revoked_at IS NOT NULL)`,
      audit(now, actor, "invite_revoked", "invite", sql`SELECT party_id, id, rev FROM invites WHERE id = ${inviteId} AND last_op = ${op}`),
      sql`SELECT revoked_at FROM invites WHERE id = ${inviteId} AND party_id = ${p}`,
    ]);
    const row = rs[3]!.results[0] as undefined | { revoked_at: number | null };
    if (row?.revoked_at != null) return rs[0]!.meta.changes === 1 ? ("revoked" as const) : ("already" as const);
    return "rejected" as const;
  }

  private otherActiveOwners(partyId: string, staffId: string): Sql {
    return sql`(SELECT COUNT(*) FROM staff o WHERE o.party_id = ${partyId} AND o.role = 'owner' AND o.disabled_at IS NULL AND o.id != ${staffId})`;
  }

  /** Owner/admin role change. Never leaves a party without an active owner. Revokes the person's sessions. */
  async changeRole(sess: SessionRef, actor: string, staffId: string, role: "owner" | "admin", now: number, op: string) {
    const ok = sessionValid(sess, ["owner"], now);
    const p = sess.partyId;
    const rs = await this.driver.batch([
      sql`UPDATE staff SET role = ${role}, rev = rev + 1, last_op = ${op}, last_action = 'role_changed'
        WHERE id = ${staffId} AND party_id = ${p} AND disabled_at IS NULL AND role IN ('owner', 'admin') AND role != ${role}
          AND (role != 'owner' OR ${this.otherActiveOwners(p, staffId)} >= 1) AND ${ok}`,
      sql`UPDATE sessions SET revoked_at = ${now} WHERE staff_id = ${staffId} AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM staff WHERE id = ${staffId} AND party_id = ${p} AND last_op = ${op})`,
      audit(now, actor, "role_changed", "staff", sql`SELECT party_id, id, rev FROM staff WHERE id = ${staffId} AND last_op = ${op}`, role),
      sql`SELECT role, disabled_at FROM staff WHERE id = ${staffId} AND party_id = ${p}`,
    ]);
    const row = rs[3]!.results[0] as undefined | { role: string; disabled_at: number | null };
    if (rs[0]!.meta.changes === 1) return "changed" as const;
    if (row && row.role === role && row.disabled_at == null) return "already" as const;
    return "rejected" as const;
  }

  /** Disables (removes) a staff member, revokes their sessions and unused invitations. Keeps one active owner. */
  async disableStaff(sess: SessionRef, actor: string, staffId: string, now: number, op: string) {
    const ok = sessionValid(sess, ["owner"], now);
    const p = sess.partyId;
    const rs = await this.driver.batch([
      sql`UPDATE staff SET disabled_at = ${now}, rev = rev + 1, last_op = ${op}, last_action = 'staff_disabled'
        WHERE id = ${staffId} AND party_id = ${p} AND disabled_at IS NULL
          AND (role != 'owner' OR ${this.otherActiveOwners(p, staffId)} >= 1) AND ${ok}`,
      sql`UPDATE sessions SET revoked_at = ${now} WHERE staff_id = ${staffId} AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM staff WHERE id = ${staffId} AND party_id = ${p} AND disabled_at IS NOT NULL)`,
      sql`UPDATE invites SET revoked_at = ${now}, revoked_by = ${actor}, rev = rev + 1, last_op = ${op}, last_action = 'invite_revoked'
        WHERE staff_id = ${staffId} AND party_id = ${p} AND used_at IS NULL AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM staff WHERE id = ${staffId} AND last_op = ${op})`,
      audit(now, actor, "staff_disabled", "staff", sql`SELECT party_id, id, rev FROM staff WHERE id = ${staffId} AND last_op = ${op}`),
      audit(now, actor, "invite_revoked", "invite", sql`SELECT party_id, id, rev FROM invites WHERE staff_id = ${staffId} AND last_op = ${op}`),
      sql`SELECT disabled_at FROM staff WHERE id = ${staffId} AND party_id = ${p}`,
    ]);
    const row = rs[5]!.results[0] as undefined | { disabled_at: number | null };
    if (rs[0]!.meta.changes === 1) return "disabled" as const;
    if (row?.disabled_at != null) return "already" as const;
    return "rejected" as const;
  }

  async listStaff(sess: SessionRef, now: number) {
    const ok = sessionValid(sess, ["owner"], now);
    const rs = await this.driver.batch([
      sql`SELECT id, name, role, invited_email, google_sub IS NOT NULL AS linked, disabled_at, created_at, rev
        FROM staff WHERE party_id = ${sess.partyId} AND ${ok} ORDER BY created_at`,
      sql`SELECT id, kind, staff_id, role, created_at, expires_at, used_at, revoked_at, rev
        FROM invites WHERE party_id = ${sess.partyId} AND ${ok} ORDER BY created_at`,
    ]);
    return { staff: rs[0]!.results, invites: rs[1]!.results };
  }

  // -------------------------------------------------------------- change log

  /**
   * Rows whose latest rev is not yet confirmed in the change log (ledger): all
   * parties, staff and invites (small tables), plus the given tickets. Tickets are
   * never scanned as a whole: there can be thousands, and admissions write their
   * own ledger record on the scan path without updating `logged_rev`.
   */
  async unlogged(limit = 50, ticketIds: string[] = []): Promise<UnloggedRow[]> {
    const rs = await this.driver.batch([
      sql`SELECT * FROM parties WHERE rev > logged_rev LIMIT ${limit}`,
      sql`SELECT * FROM staff WHERE rev > logged_rev LIMIT ${limit}`,
      sql`SELECT * FROM invites WHERE rev > logged_rev LIMIT ${limit}`,
      ticketIds.length
        ? sql`SELECT * FROM tickets WHERE id IN (${inList(ticketIds)}) AND rev > logged_rev LIMIT ${limit}`
        : sql`SELECT 1 WHERE 0`,
    ]);
    const out: UnloggedRow[] = [];
    const add = (entity: LogEntity, rows: Record<string, unknown>[]) => {
      for (const r of rows) {
        const { logged_rev: _ignored, ...state } = r;
        out.push({
          entity,
          id: String(r.id),
          party_id: String(entity === "party" ? r.id : r.party_id),
          rev: Number(r.rev),
          state,
        });
      }
    };
    add("party", rs[0]!.results);
    add("staff", rs[1]!.results);
    add("invite", rs[2]!.results);
    add("ticket", rs[3]!.results);
    return out;
  }

  async markLogged(rows: { entity: LogEntity; id: string; rev: number }[]): Promise<void> {
    if (rows.length === 0) return;
    const table = { party: "parties", staff: "staff", invite: "invites", ticket: "tickets" } as const;
    await this.driver.batch(
      rows.map((r) => {
        const t = table[r.entity];
        // Table names come from the fixed map above, never from input.
        return {
          text: `UPDATE ${t} SET logged_rev = ? WHERE id = ? AND logged_rev < ? AND rev >= ?`,
          params: [r.rev, r.id, r.rev, r.rev],
        };
      }),
    );
  }
}
