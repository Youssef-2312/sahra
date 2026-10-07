import { Hono } from "hono";
import { normalizeEmail } from "../auth/google";
import { flushChangeLog } from "../changelog";
import { json, readJson, requireAuth, type AppEnv } from "../context";
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
  const r = await c.var.db.createGoogleInvite({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, {
    staffId: b.staff_id, inviteId: b.invite_id, name, email, role, now, expiresAt: now + h * 3600_000, op: newId(),
  });
  if (r === "rejected") return json(c, 409, { error: "not_allowed_or_already_invited" });
  await flushChangeLog(c.var.db, c.var.store, now);
  return json(c, 200, { status: r, email });
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
  await flushChangeLog(c.var.db, c.var.store, now);
  return json(c, 200, { status: r, expires_at: now + h * 3600_000 });
});

staffRoutes.post("/:id/role", requireAuth(["owner"]), async (c) => {
  const id = c.req.param("id");
  const b = await readJson(c);
  if (!isUuid(id) || (b?.role !== "owner" && b?.role !== "admin")) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const now = c.var.deps.now();
  const r = await c.var.db.changeRole({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, id, b.role, now, newId());
  if (r === "rejected") return json(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.store, now);
  return json(c, 200, { status: r });
});

staffRoutes.post("/:id/disable", requireAuth(["owner"]), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const now = c.var.deps.now();
  const r = await c.var.db.disableStaff({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, id, now, newId());
  if (r === "rejected") return json(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.store, now);
  return json(c, 200, { status: r });
});
