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
import { DEFAULT_TIME_ZONE, isTimeZone } from "../party/time";
import { normalizeEmail } from "../auth/google";
import { flushChangeLog } from "../changelog";
import { recordIntent } from "../changes";
import { json, readJson } from "../context";
import { CONFIG } from "../env";
import { COOKIE_SESSION, clearCookie, cookie } from "../lib/http";
import { csrfFor, isUuid, newId, newToken, sha256hex } from "../lib/crypto";
import { COOKIE_PLATFORM, requirePlatform, type PCtx, type PlatformEnv } from "../platform/auth";
import { MAX_PARTY_LIMIT, PLATFORM, platformSessionFor, siteOwnerValid } from "../platform/db";
import { healthView } from "../health";
import { discordStatus } from "../health/discord";
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
  // Losing this in a recovery would give the organiser (and their party
  // management) back: intents first, for the organiser and each staff row.
  await recordIntent(c.var.ledger, op, PLATFORM, "organiser_disabled", [{ entity: "organiser", id }], now);
  const intended = await c.var.pdb.staffOfOrganiser(id);
  await recordStaffIntents(c, op, intended, now);
  const r = await c.var.pdb.disableOrganiser(p.hash, p.info.site_owner_id!, id, now, op);
  if (r.status === "rejected") return j(c, 409, { error: "not_allowed" });
  // A staff row created between the read and the batch (e.g. a party created at
  // that moment) was disabled too; its intent is written now, before confirming.
  const known = new Set(intended.map((x) => x.id));
  await recordStaffIntents(c, op, r.staff.filter((x) => !known.has(x.id)), now);
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r.status, staff_disabled: r.staff.length });
});

async function recordStaffIntents(c: PCtx, op: string, rows: { id: string; party_id: string }[], now: number) {
  const byParty = new Map<string, { entity: string; id: string }[]>();
  for (const x of rows) byParty.set(x.party_id, [...(byParty.get(x.party_id) ?? []), { entity: "staff", id: x.id }]);
  for (const [partyId, targets] of byParty) await recordIntent(c.var.ledger, op, partyId, "staff_disabled", targets, now);
}

/**
 * Appoint an owner for a party with no active owner (for example after its
 * organiser was switched off): a Google owner invitation, 14 days, logged and
 * audited. The browser supplies the ids, so a retry is recognized.
 */
platformRoutes.post("/parties/:id/owner-invite", requirePlatform(["site_owner"]), async (c) => {
  const partyId = c.req.param("id");
  const b = await readJson(c as never);
  const name = cleanName(b?.name);
  const email = typeof b?.email === "string" ? normalizeEmail(b.email) : null;
  if (!PARTY_ID.test(partyId) || !b || !isUuid(b.staff_id) || !isUuid(b.invite_id) || !name || !email) {
    return j(c, 400, { error: "invalid_request" });
  }
  const p = c.var.platform;
  const now = c.var.deps.now();
  const expiresAt = now + CONFIG.inviteMaxHours * 3600_000;
  const r = await c.var.pdb.ownerInvite(p.hash, p.info.site_owner_id!, partyId, {
    staffId: b.staff_id, inviteId: b.invite_id, name, email, now, expiresAt, op: newId(),
  });
  if (r === "not_found") return j(c, 404, { error: "not_found" });
  if (r === "has_owner") return j(c, 409, { error: "party_has_an_active_owner" });
  if (r === "party_disabled") return j(c, 409, { error: "party_disabled" });
  if (r === "rejected") return j(c, 409, { error: "not_allowed_or_already_invited" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r, email, expires_at: expiresAt });
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
  const view = await healthView(c.var.db.driver, siteOwnerValid(p.hash, p.info.site_owner_id!, now), now, discordStatus(c.env.DISCORD_WEBHOOK_URL));
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
  // Their access to parties ends with the removal: intents for those staff rows too.
  const intended = await c.var.pdb.staffOfSiteOwner(id);
  await recordStaffIntents(c, op, intended, now);
  const r = await c.var.pdb.removeSiteOwner(p.hash, p.info.site_owner_id!, id, now, op);
  if (r.status === "not_found") return j(c, 404, { error: "not_found" });
  if (r.status === "rejected") return j(c, 409, { error: "not_allowed" });
  const known = new Set(intended.map((x) => x.id));
  await recordStaffIntents(c, op, r.staff.filter((x) => !known.has(x.id)), now);
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r.status, staff_disabled: r.staff.length });
});

/**
 * Manage any party (owner decision): the site owner gets an ordinary owner staff
 * row there (shown in the party's staff list as "<name> (site owner)", every
 * change audited under it) and an ordinary owner session, set as the party
 * session cookie. Every party owner feature then works with its own authority
 * checks. Removing the site owner ends this access.
 */
platformRoutes.post("/parties/:id/manage", requirePlatform(["site_owner"]), async (c) => {
  const partyId = c.req.param("id");
  if (!PARTY_ID.test(partyId)) return j(c, 400, { error: "invalid_request" });
  const p = c.var.platform;
  const now = c.var.deps.now();
  const row = await c.var.pdb.enterPartyRow(p.hash, p.info.site_owner_id!, partyId, { staffId: newId(), now, op: newId() });
  if (row.status === "not_found") return j(c, 404, { error: "not_found" });
  if (row.status === "party_disabled") return j(c, 409, { error: "party_disabled" });
  if (row.status === "on_hold") return j(c, 409, { error: "on_hold_after_recovery" });
  if (row.status !== "ok") return j(c, 409, { error: "not_allowed" });
  // The row is confirmed in the change log before a session is handed out.
  await flushChangeLog(c.var.db, c.var.ledger, now);
  const token = newToken();
  const expiresAt = now + CONFIG.googleSessionMs;
  const s = await c.var.pdb.enterPartySession(p.hash, p.info.site_owner_id!, partyId, {
    staffId: row.staffId, sessionHash: await sha256hex(token), now, expiresAt,
  });
  if (s === "capped") return j(c, 429, { error: "too_many_sessions" });
  if (s !== "created") return j(c, 409, { error: "not_allowed" });
  const res = j(c, 200, { status: "managing", party: partyId, expires_at: expiresAt });
  res.headers.append("set-cookie", cookie(COOKIE_SESSION, token, { maxAgeS: CONFIG.googleSessionMs / 1000, sameSite: "Strict" }));
  return res;
});

// ------------------------------------------------------------ one sign-in

/**
 * The parties this Google account is on the team of (owner or admin), for the
 * "My parties" page: one sign-in, then open any of them.
 */
platformRoutes.get("/teams", requirePlatform(["site_owner", "organiser"]), async (c) => {
  const rows = await c.var.db.activeStaffForSub(c.var.platform.info.google_sub);
  return j(c, 200, { teams: rows.map((r) => ({ party_id: r.party_id, party_name: r.party_name, role: r.role })) });
});

/**
 * Open one of those parties without signing in again: a party session for the
 * same Google account's own staff row there. The insert itself requires the
 * platform session to be live and of that account, and the staff row to be
 * active, linked to it and owner or admin (the same rule as choosing a party
 * after sign-in, src/routes/auth.ts).
 */
platformRoutes.post("/parties/:id/open", requirePlatform(["site_owner", "organiser"]), async (c) => {
  const partyId = c.req.param("id");
  if (!PARTY_ID.test(partyId)) return j(c, 400, { error: "invalid_request" });
  const p = c.var.platform;
  const now = c.var.deps.now();
  const s = (await c.var.db.activeStaffForSub(p.info.google_sub)).find((x) => x.party_id === partyId);
  if (!s) return j(c, 404, { error: "not_found" });
  const token = newToken();
  const expiresAt = now + CONFIG.googleSessionMs;
  const ok = await c.var.db.createGoogleSession({
    hash: await sha256hex(token), staffId: s.staff_id, partyId, sub: p.info.google_sub, now, expiresAt,
    guard: platformSessionFor(p.hash, p.info.google_sub, now),
  });
  if (ok === "capped") return j(c, 429, { error: "too_many_sessions" });
  if (ok !== "created") return j(c, 409, { error: "not_allowed" });
  const res = j(c, 200, { status: "opened", party: partyId, role: s.role, expires_at: expiresAt });
  res.headers.append("set-cookie", cookie(COOKIE_SESSION, token, { maxAgeS: CONFIG.googleSessionMs / 1000, sameSite: "Strict" }));
  return res;
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
  // Default time zone: the creator's, from their connection (Cloudflare's request.cf),
  // else Cairo. The owner can change it on the party page.
  const cfZone = (c.req.raw as Request & { cf?: { timezone?: unknown } }).cf?.timezone;
  const timeZone = isTimeZone(cfZone) ? (cfZone as string) : DEFAULT_TIME_ZONE;
  const r = await c.var.pdb.createParty(p.hash, p.info.organiser_id!, {
    partyId: b.id, name, capacity, staffId: b.staff_id, now, op: newId(), timeZone,
  });
  if (r === "forbidden") return j(c, 403, { error: "forbidden" });
  if (r === "limit") return j(c, 409, { error: "party_limit_reached" });
  if (r === "id_taken") return j(c, 409, { error: "party_id_taken" });
  if (r === "rejected") return j(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return j(c, 200, { status: r, party: { id: b.id, name } });
});
