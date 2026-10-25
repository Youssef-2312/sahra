import { Hono } from "hono/tiny";
import { normalizeEmail } from "../auth/google";
import { flushChangeLog } from "../changelog";
import { recordIntent } from "../changes";
import { json, readJson, requireAuth, type AppEnv } from "../context";
import { staffInvitation } from "../email/staff-invite";
import { sessionValid } from "../db";
import { sql } from "../db/sql";
import { outboxInsert } from "../outbox";
import { chargeStaff } from "../limits";
import { CONFIG } from "../env";
import { isUuid, newId, parseToken, sha256hex } from "../lib/crypto";

export const staffRoutes = new Hono<AppEnv>();

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s.length >= 1 && s.length <= 80 ? s : null;
}

function hours(v: unknown, dflt: number): number | null {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > CONFIG.inviteMaxHours) return null;
  return v;
}

staffRoutes.get("/", requireAuth(["owner"]), async (c) => {
  const a = c.var.auth;
  return json(c, 200, await c.var.db.listStaff({ hash: a.hash, partyId: a.info.party_id }, c.var.deps.now()));
});

/**
 * Invite an owner or admin by email (Google sign-in). The browser supplies the
 * new staff and invite ids, so a retry after "pending" is recognized, not duplicated.
 */
staffRoutes.post("/google-invite", requireAuth(["owner"]), async (c) => {
  const b = await readJson(c);
  const name = cleanName(b?.name);
  const email = typeof b?.email === "string" ? normalizeEmail(b.email) : null;
  const role = b?.role;
  const h = hours(b?.hours, CONFIG.googleInviteDefaultHours);
  if (!b || !isUuid(b.staff_id) || !isUuid(b.invite_id) || !name || !email || (role !== "owner" && role !== "admin") || !h) {
    return json(c, 400, { error: "invalid_request" });
  }
  const a = c.var.auth;
  const now = c.var.deps.now();
  const over=await chargeStaff(c,"resend_link",1,["owner"]);if(over)return over;
  const party=(await c.var.db.driver.all<{name:string}>(sql`SELECT name FROM parties WHERE id = ${a.info.party_id}`)).results[0];
  const expiresAt=now+h*3600_000;
  const mail=staffInvitation({id:b.invite_id,partyId:a.info.party_id,partyName:party?.name || "Sahra",name,email,origin:c.env.PUBLIC_ORIGIN,expiresAt,now,actor:a.info.staff_id});
  const r = await c.var.db.createGoogleInvite({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, {
    staffId: b.staff_id, inviteId: b.invite_id, name, email, role, now, expiresAt, op: newId(), mail,
  });
  if (r === "rejected") return json(c, 409, { error: "not_allowed_or_already_invited" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  const emailStatus=(await c.var.db.driver.all<{status:string}>(sql`SELECT status FROM outbox WHERE id=${mail.id} AND party_id=${a.info.party_id}`)).results[0]?.status ?? null;
  return json(c, 200, { status: r, email, email_status:emailStatus });
});

/** Re-notify an existing, active Google invitation; no access is created here. */
staffRoutes.post("/:id/resend-invitation",requireAuth(["owner"]),async(c)=>{
  const id=c.req.param("id"),b=await readJson(c);
  if(!isUuid(id)||!isUuid(b?.op))return json(c,400,{error:"invalid_request"});
  const a=c.var.auth,now=c.var.deps.now(),sess={hash:a.hash,partyId:a.info.party_id},ok=sessionValid(sess,["owner"],now);
  const row=(await c.var.db.driver.all<{name:string;email:string;party_name:string;expires_at:number}>(sql`SELECT st.name,st.invited_email AS email,p.name AS party_name,MAX(i.expires_at) AS expires_at
    FROM staff st JOIN parties p ON p.id=st.party_id JOIN invites i ON i.staff_id=st.id AND i.party_id=st.party_id
    WHERE st.id=${id} AND st.party_id=${sess.partyId} AND st.disabled_at IS NULL AND st.google_sub IS NULL
      AND st.role IN ('owner','admin') AND i.kind='google' AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>${now} AND ${ok}
    GROUP BY st.id`)).results[0];
  if(!row)return json(c,409,{error:"not_allowed"});
  const over=await chargeStaff(c,"resend_link",1,["owner"]);if(over)return over;
  const mail=staffInvitation({id:b.op,partyId:sess.partyId,partyName:row.party_name,name:row.name,email:row.email,origin:c.env.PUBLIC_ORIGIN,expiresAt:row.expires_at,now,actor:a.info.staff_id});
  const r=await c.var.db.driver.all(outboxInsert(mail,sql`${ok} AND EXISTS (SELECT 1 FROM staff st JOIN invites i ON i.staff_id=st.id AND i.party_id=st.party_id
    WHERE st.id=${id} AND st.party_id=${sess.partyId} AND st.disabled_at IS NULL AND st.google_sub IS NULL AND st.invited_email=${row.email}
      AND st.role IN ('owner','admin') AND i.kind='google' AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>${now})
    AND NOT EXISTS (SELECT 1 FROM outbox WHERE id=${mail.id})
    AND NOT EXISTS (SELECT 1 FROM outbox WHERE party_id=${sess.partyId} AND kind='staff_invite' AND to_email=${row.email}
      AND status IN ('queued','sending','sent') AND created_at>${now-600000})`));
  if(r.meta.changes)return json(c,200,{status:"queued"});
  const prior=(await c.var.db.driver.all(sql`SELECT 1 AS ok WHERE ${ok} AND EXISTS (SELECT 1 FROM staff st JOIN invites i ON i.staff_id=st.id AND i.party_id=st.party_id
    WHERE st.id=${id} AND st.party_id=${sess.partyId} AND st.disabled_at IS NULL AND st.google_sub IS NULL AND st.invited_email=${row.email}
      AND st.role IN ('owner','admin') AND i.kind='google' AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>${now})
    AND EXISTS (SELECT 1 FROM outbox WHERE party_id=${sess.partyId} AND kind='staff_invite' AND to_email=${row.email}
      AND (id=${mail.id} OR (status IN ('queued','sending','sent') AND created_at>${now-600000})))`)).results[0];
  return prior ? json(c,200,{status:"already_queued"}) : json(c,409,{error:"not_allowed"});
});

/**
 * Create a door invitation (new door staff member when `name` is given, or a new
 * invitation for an existing door staff member). The owner's browser generates
 * the 256-bit invitation token and builds the link; only its SHA-256 is stored.
 */
staffRoutes.post("/door-invite", requireAuth(["owner"]), async (c) => {
  const b = await readJson(c);
  const name = b?.name === undefined || b?.name === null ? null : cleanName(b.name);
  const h = hours(b?.hours, CONFIG.doorInviteDefaultHours);
  if (!b || !isUuid(b.staff_id) || !isUuid(b.invite_id) || !parseToken(b.token) || !h) return json(c, 400, { error: "invalid_request" });
  if (b.name !== undefined && b.name !== null && !name) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const now = c.var.deps.now();
  let r;
  try {
    r = await c.var.db.createDoorInvite({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, {
      staffId: b.staff_id, inviteId: b.invite_id, name, tokenHash: await sha256hex(b.token as string),
      now, expiresAt: now + h * 3600_000, op: newId(),
    });
  } catch (e) {
    // A reused token hits the UNIQUE index; the whole batch rolls back.
    if (/UNIQUE/i.test(String((e as Error).message))) return json(c, 409, { error: "token_conflict" });
    throw e;
  }
  if (r === "rejected") return json(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, { status: r, expires_at: now + h * 3600_000 });
});

staffRoutes.post("/:id/role", requireAuth(["owner"]), async (c) => {
  const id = c.req.param("id");
  const b = await readJson(c);
  if (!isUuid(id) || (b?.role !== "owner" && b?.role !== "admin")) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const now = c.var.deps.now();
  const op = newId();
  // Losing a demotion in a recovery would hand the role back: intent first (src/changes.ts).
  await recordIntent(c.var.ledger, op, a.info.party_id, "role_changed", [{ entity: "staff", id }], now);
  const r = await c.var.db.changeRole({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, id, b.role, now, op);
  if (r === "rejected") return json(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, { status: r });
});

staffRoutes.post("/:id/disable", requireAuth(["owner"]), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const now = c.var.deps.now();
  const op = newId();
  await recordIntent(c.var.ledger, op, a.info.party_id, "staff_disabled", [{ entity: "staff", id }], now);
  const r = await c.var.db.disableStaff({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, id, now, op);
  if (r === "rejected") return json(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, { status: r });
});
