import { Hono } from "hono";
import { flushChangeLog } from "../changelog";
import { json, readJson, requireAuth, type AppEnv } from "../context";
import { CONFIG } from "../env";
import { isUuid, newId, parseToken, sha256hex } from "../lib/crypto";
import { COOKIE_SESSION, clientIp, cookie, rateLimited, sameOrigin } from "../lib/http";

export const inviteRoutes = new Hono<AppEnv>();

/**
 * Door staff join. The browser sends the invitation token and a 256-bit value it
 * generated and saved; that value becomes the session token (only its hash is
 * stored). Consuming the invitation and creating the session is one batch, so
 * two simultaneous joins produce exactly one session. A retry with the same
 * value is answered with success again; any other value gets "already used".
 */
inviteRoutes.post("/consume", async (c) => {
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c, 403, { error: "bad_origin" });
  if (await rateLimited(c.env.RL_AUTH, `join:${clientIp(c)}`)) return json(c, 429, { error: "rate_limited" });
  const body = await readJson(c);
  const token = body?.token;
  const session = body?.session;
  if (!parseToken(token) || !parseToken(session)) return json(c, 400, { error: "invalid_request" });
  if (token === session) return json(c, 400, { error: "invalid_request" });

  const now = c.var.deps.now();
  const sessionHash = await sha256hex(session as string);
  const row = await c.var.db.consumeDoorInvite({
    tokenHash: await sha256hex(token as string),
    sessionHash,
    now,
    expiresAt: now + CONFIG.doorSessionMs,
    op: newId(),
  });
  if (!row) return json(c, 404, { error: "invalid_invitation" });
  const mine = row.session_hash === sessionHash && row.s_hash === sessionHash;
  if (!mine) {
    if (row.revoked_at != null) return json(c, 410, { error: "invitation_revoked" });
    if (row.used_at != null) return json(c, 409, { error: "invitation_already_used" });
    if (row.expires_at <= now) return json(c, 410, { error: "invitation_expired" });
    return json(c, 403, { error: "invitation_not_usable" });
  }
  if (row.revoked_at != null || row.s_revoked_at != null) return json(c, 410, { error: "invitation_revoked" });
  if (row.staff_disabled_at != null) return json(c, 403, { error: "invitation_not_usable" });
  if ((row.s_expires_at ?? 0) <= now) return json(c, 410, { error: "session_expired" });

  // Confirm the invitation use in the change log before telling the browser it worked.
  await flushChangeLog(c.var.db, c.var.store, now);

  const res = json(c, 200, { status: "joined", staff_name: row.staff_name, expires_at: row.s_expires_at });
  res.headers.append(
    "set-cookie",
    cookie(COOKIE_SESSION, session as string, { maxAgeS: Math.floor(((row.s_expires_at ?? now) - now) / 1000), sameSite: "Strict" }),
  );
  return res;
});

inviteRoutes.post("/:id/revoke", requireAuth(["owner"]), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const now = c.var.deps.now();
  const r = await c.var.db.revokeInvite({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, id, now, newId());
  if (r === "rejected") return json(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.store, now);
  return json(c, 200, { status: r });
});
