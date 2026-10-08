// Site owner and organiser endpoints (workstream B). Sign-in is in
// src/routes/auth.ts (/api/auth/platform/start, shared callback); sessions and
// the role check are in src/platform/auth.ts.
//
// Site owner (the top level; table platform_admins): invite or disable
// organisers, set an organiser's party limit, disable or re-enable a party,
// remove another site owner, per-party counts (no guest data). Organiser: create a party (they become its owner and then
// sign in to it like any staff member), list their parties.
//
// Disabling a party: control object first (paused, pause_number + 1, conditional
// on its rev, as an admission pause), then ONE main batch (disabled + paused,
// every session and unused invitation revoked, audit). Scanners stop as soon as
// the control object changes.

import { Hono } from "hono/tiny";
import { normalizeEmail } from "../auth/google";
import { flushChangeLog } from "../changelog";
import { recordIntent } from "../changes";
import { json, readJson } from "../context";
import { CONFIG } from "../env";
import { clearCookie } from "../lib/http";
import { csrfFor, isUuid, newId } from "../lib/crypto";
import { COOKIE_PLATFORM, requirePlatform, type PCtx, type PlatformEnv } from "../platform/auth";
import { MAX_PARTY_LIMIT, PLATFORM, siteOwnerValid } from "../platform/db";
import { healthView } from "../health";
import { LIMITS } from "../limits";

export const platformRoutes = new Hono<PlatformEnv>();

const j = (c: PCtx, status: number, body: unknown) => json(c as never, status, body);

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s.length >= 1 && s.length <= 80 ? s : null;
}

/** Same party id rule as scripts/create-party.mjs; never starts with "_" (reserved for "_platform"). */
const PARTY_ID = /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/;

platformRoutes.get("/me", requirePlatform(["site_owner", "organiser"]), async (c) => {
  const p = c.var.platform;
  return j(c, 200, {
    site_owner: p.info.site_owner_id ? { id: p.info.site_owner_id, name: p.info.site_owner_name } : null,
    organiser: p.info.organiser_id ? { id: p.info.organiser_id, name: p.info.organiser_name } : null,
    expires_at: p.info.expires_at,
    csrf: await csrfFor(p.token),
  });
});

platformRoutes.post("/logout", requirePlatform(["site_owner", "organiser"]), async (c) => {
  await c.var.pdb.revokeSession(c.var.platform.hash, c.var.deps.now());
  const res = j(c, 200, { status: "signed_out" });
  res.headers.append("set-cookie", clearCookie(COOKIE_PLATFORM));
  return res;
});

// ------------------------------------------------------------ site owner

platformRoutes.get("/organisers", requirePlatform(["site_owner"]), async (c) => {
  const p = c.var.platform;
  return j(c, 200, await c.var.pdb.listOrganisers(p.hash, p.info.site_owner_id!, c.var.deps.now()));
});

/** Invite an organiser by email. The browser supplies the ids, so a retry after "pending" is recognized. */
platformRoutes.post("/organisers", requirePlatform(["site_owner"]), async (c) => {
  const b = await readJson(c as never);
  const name = cleanName(b?.name);
  const email = typeof b?.email === "string" ? normalizeEmail(b.email) : null;
  const hours = b?.hours ?? CONFIG.googleInviteDefaultHours;
  if (!b || !isUuid(b.organiser_id) || !isUuid(b.invite_id) || !name || !email
    || typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > CONFIG.inviteMaxHours) {
    return j(c, 400, { error: "invalid_request" });
  }
  const p = c.var.platform;
  const now = c.var.deps.now();
  const r = await c.var.pdb.inviteOrganiser(p.hash, p.info.site_owner_id!, {
    organiserId: b.organiser_id, inviteId: b.invite_id, name, email, now, expiresAt: now + hours * 3600_000, op: newId(),
  });
  if (r === "rejected") return j(c, 409, { error: "not_allowed_or_already_invited" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r, email });
});

platformRoutes.post("/organisers/:id/disable", requirePlatform(["site_owner"]), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return j(c, 400, { error: "invalid_request" });
  const p = c.var.platform;
  const now = c.var.deps.now();
  const op = newId();
  // Losing this in a recovery would give the organiser access back: intent first.
  await recordIntent(c.var.ledger, op, PLATFORM, "organiser_disabled", [{ entity: "organiser", id }], now);
  const r = await c.var.pdb.disableOrganiser(p.hash, p.info.site_owner_id!, id, now, op);
  if (r === "rejected") return j(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r });
});

platformRoutes.get("/parties", requirePlatform(["site_owner"]), async (c) => {
  const p = c.var.platform;
  return j(c, 200, await c.var.pdb.partyCounts(p.hash, p.info.site_owner_id!, c.var.deps.now()));
});

/**
 * Health checks (workstream F, src/health/): each check's state, the latest run,
 * recent alerts, the daily usage estimate and today's per-party counters with
 * their limits. Read-only; the site owner check is inside every statement.
 */
platformRoutes.get("/health", requirePlatform(["site_owner"]), async (c) => {
  const p = c.var.platform;
  const now = c.var.deps.now();
  const view = await healthView(c.var.db.driver, siteOwnerValid(p.hash, p.info.site_owner_id!, now), now);
  return j(c, 200, { ...view, limits: LIMITS });
});

platformRoutes.post("/parties/:id/disable", requirePlatform(["site_owner"]), async (c) => {
  const partyId = c.req.param("id");
  if (!PARTY_ID.test(partyId)) return j(c, 400, { error: "invalid_request" });
  const p = c.var.platform;
  const now = c.var.deps.now();
  const party = await c.var.pdb.partyForDisable(partyId);
  if (!party) return j(c, 404, { error: "not_found" });
  const op = newId();
  await recordIntent(c.var.ledger, op, partyId, "party_disabled", [{ entity: "party", id: partyId }], now);
  // 1. Control object (ledger): paused, pause_number + 1, conditional on its rev.
  const control = await c.var.ledger.getControl(partyId);
  let pn = Math.max(control?.pause_number ?? 0, party.pause_number);
  if (party.disabled_at == null || control?.state !== "paused") {
    pn += 1;
    if (!(await c.var.ledger.setControl(partyId, control?.rev ?? 0, { state: "paused", pause_number: pn }, now, p.info.site_owner_id))) {
      return j(c, 409, { error: "changed_meanwhile_try_again" });
    }
  }
  // 2. Main database, one batch.
  const r = await c.var.pdb.disableParty(p.hash, p.info.site_owner_id!, partyId, pn, now, op);
  if (r === "rejected") return j(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r, pause_number: pn });
});

/** Re-enable a disabled party: no intent (safe to lose); it stays paused until its owners reopen admission. */
platformRoutes.post("/parties/:id/enable", requirePlatform(["site_owner"]), async (c) => {
  const partyId = c.req.param("id");
  if (!PARTY_ID.test(partyId)) return j(c, 400, { error: "invalid_request" });
  const p = c.var.platform;
  const now = c.var.deps.now();
  const r = await c.var.pdb.enableParty(p.hash, p.info.site_owner_id!, partyId, now, newId());
  if (r === "not_found") return j(c, 404, { error: "not_found" });
  if (r === "rejected") return j(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r, admission: "paused" });
});

platformRoutes.post("/organisers/:id/party-limit", requirePlatform(["site_owner"]), async (c) => {
  const id = c.req.param("id");
  const b = await readJson(c as never);
  const limit = b?.limit;
  if (!isUuid(id) || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_PARTY_LIMIT) {
    return j(c, 400, { error: "invalid_request" });
  }
  const p = c.var.platform;
  const now = c.var.deps.now();
  const r = await c.var.pdb.setPartyLimit(p.hash, p.info.site_owner_id!, id, limit, now, newId());
  if (r === "not_found") return j(c, 404, { error: "not_found" });
  if (r === "rejected") return j(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r, party_limit: limit });
});

platformRoutes.get("/site-owners", requirePlatform(["site_owner"]), async (c) => {
  const p = c.var.platform;
  return j(c, 200, await c.var.pdb.listSiteOwners(p.hash, p.info.site_owner_id!, c.var.deps.now()));
});

/** Remove another site owner (never yourself, never the last one). Intent first: a removal must survive a recovery. */
platformRoutes.post("/site-owners/:id/remove", requirePlatform(["site_owner"]), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return j(c, 400, { error: "invalid_request" });
  const p = c.var.platform;
  if (id === p.info.site_owner_id) return j(c, 409, { error: "cannot_remove_yourself" });
  const now = c.var.deps.now();
  const op = newId();
  await recordIntent(c.var.ledger, op, PLATFORM, "site_owner_removed", [{ entity: "platform_admin", id }], now);
  const r = await c.var.pdb.removeSiteOwner(p.hash, p.info.site_owner_id!, id, now, op);
  if (r === "not_found") return j(c, 404, { error: "not_found" });
  if (r === "rejected") return j(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r });
});

// ------------------------------------------------------------ organiser

platformRoutes.get("/my-parties", requirePlatform(["organiser"]), async (c) => {
  const p = c.var.platform;
  return j(c, 200, { parties: await c.var.pdb.myParties(p.hash, p.info.organiser_id!, c.var.deps.now()) });
});

/**
 * Create a party. The organiser becomes its owner (staff row linked to their
 * Google account) in the same batch; they then sign in to it as staff. The
 * browser supplies the party id and the staff id, so a retry is recognized.
 */
platformRoutes.post("/parties", requirePlatform(["organiser"]), async (c) => {
  const b = await readJson(c as never);
  const name = cleanName(b?.name);
  const capacity = b?.capacity;
  if (!b || typeof b.id !== "string" || !PARTY_ID.test(b.id) || !name || !isUuid(b.staff_id)
    || typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1 || capacity > 100_000) {
    return j(c, 400, { error: "invalid_request" });
  }
  const p = c.var.platform;
  const now = c.var.deps.now();
  const r = await c.var.pdb.createParty(p.hash, p.info.organiser_id!, {
    partyId: b.id, name, capacity, staffId: b.staff_id, now, op: newId(),
  });
  if (r === "forbidden") return j(c, 403, { error: "forbidden" });
  if (r === "limit") return j(c, 409, { error: "party_limit_reached" });
  if (r === "id_taken") return j(c, 409, { error: "party_id_taken" });
  if (r === "rejected") return j(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r, party: { id: b.id, name } });
});
