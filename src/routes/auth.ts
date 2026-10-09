import { Hono } from "hono/tiny";
import { json, requireAuth, type AppEnv, type Ctx } from "../context";
import { authUrl, canAutoLink, exchangeCode, normalizeEmail, pkceChallenge, verifyIdToken, AuthError } from "../auth/google";
import { flushChangeLog } from "../changelog";
import { CONFIG } from "../env";
import { platformCallback, platformSession } from "../platform/auth";
import { PlatformDb } from "../platform/db";
import { noticeResponse } from "../auth/notices";
import { newId, newToken, parseToken, seal, sha256hex, timingSafeEqualStr, unseal } from "../lib/crypto";
import {
  COOKIE_LOGIN,
  COOKIE_PICK,
  COOKIE_SESSION,
  clearCookie,
  clientIp,
  cookie,
  escapeHtml,
  rateLimited,
  readCookie,
  sameOrigin,
} from "../lib/http";

export const authRoutes = new Hono<AppEnv>();

function redirectUri(c: Ctx): string {
  return `${c.env.PUBLIC_ORIGIN}/api/auth/google/callback`;
}

function envRecord(c: Ctx): Record<string, unknown> {
  return c.env as unknown as Record<string, unknown>;
}

const LOGIN_PURPOSE = "login-attempt";
const PICK_PURPOSE = "party-pick";

// Step 1: our sign-in page POSTs here (a form). Nothing is written to the database:
// state, nonce and the PKCE verifier travel in a sealed (AES-GCM, key id, expiry),
// short-lived Lax cookie, and the browser goes to Google.
async function startSignIn(c: Ctx, platform: boolean) {
  // A form post from the sign-in page, so the answers are pages, not JSON.
  const back = platform ? "/platform" : "/signin";
  const backLabel = platform ? "Back to platform sign in" : undefined;
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return noticeResponse(c, 403, "bad_origin", { back, backLabel });
  if (await rateLimited(c.env.RL_AUTH, `login:${clientIp(c)}`)) return noticeResponse(c, 429, "too_many", { back, backLabel });
  const now = c.var.deps.now();
  const state = newToken();
  const nonce = newToken();
  const codeVerifier = newToken();
  // `p` marks a platform (admin/organiser) sign-in; it is sealed, so it cannot be changed on the way.
  const attempt: Record<string, unknown> = { s: state, n: nonce, v: codeVerifier };
  if (platform) attempt.p = 1;
  const sealed = await seal(envRecord(c), LOGIN_PURPOSE, attempt, now + CONFIG.loginAttemptMs);
  const url = authUrl({
    clientId: c.env.GOOGLE_CLIENT_ID,
    redirectUri: redirectUri(c),
    state,
    nonce,
    challenge: await pkceChallenge(codeVerifier),
  });
  const res = c.redirect(url, 303);
  // Lax so it is sent on Google's top-level redirect back to us.
  res.headers.append("set-cookie", cookie(COOKIE_LOGIN, sealed, { maxAgeS: CONFIG.loginAttemptMs / 1000, sameSite: "Lax" }));
  return res;
}

// The sign-in page's one "Continue with Google" (owner: one button): the callback
// finds every kind of access the account has (party team, organiser, site owner).
authRoutes.post("/google/start", (c) => startSignIn(c, false));
// The platform page's own button: platform access only, a separate session (src/platform/auth.ts).
authRoutes.post("/platform/start", (c) => startSignIn(c, true));

// Step 2: Google redirects back here. The sealed cookie must exist, be genuine and
// unexpired, and hold the same state as the URL (this binds the sign-in to the
// browser that started it). The code is exchanged and the ID token fully verified
// BEFORE any database access. Single use comes from Google's one-time code and the
// nonce check; the cookie is cleared on every outcome.
authRoutes.get("/google/callback", async (c) => {
  const clear = [clearCookie(COOKIE_LOGIN, "Lax")];
  if (await rateLimited(c.env.RL_AUTH, `callback:${clientIp(c)}`)) {
    return noticeResponse(c, 429, "too_many", { cookies: clear });
  }
  if (c.req.query("error")) {
    return noticeResponse(c, 400, "cancelled", { cookies: clear });
  }
  const now = c.var.deps.now();
  const sealed = readCookie(c, COOKIE_LOGIN);
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const attempt = sealed ? await unseal(envRecord(c), LOGIN_PURPOSE, sealed, now) : null;
  if (
    !attempt || typeof attempt.s !== "string" || typeof attempt.n !== "string" || typeof attempt.v !== "string" ||
    !parseToken(state) || !timingSafeEqualStr(state, attempt.s) || !code || code.length > 2048
  ) {
    return noticeResponse(c, 400, "expired", { cookies: clear });
  }
  if (!c.env.GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_SECRET not set");

  let claims;
  try {
    const idToken = await exchangeCode(c.var.deps.fetch, {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUri(c),
      code,
      codeVerifier: attempt.v,
    });
    claims = await verifyIdToken(idToken, {
      clientId: c.env.GOOGLE_CLIENT_ID,
      expectedNonceHash: await sha256hex(attempt.n),
      jwks: c.var.deps.jwks,
      nowMs: now,
    });
  } catch (e) {
    const codeName = e instanceof AuthError ? e.code : "error";
    console.log(JSON.stringify({ evt: "login_rejected", reason: codeName }));
    return noticeResponse(c, 401, "not_verified", { detail: codeName, cookies: clear });
  }

  // From here on the request carries a verified Google identity. Writes happen
  // only if that identity matches a pending invitation or is active staff.
  if (attempt.p === 1) return platformCallback(c, claims, clear);
  const db = c.var.db;
  const pdb = new PlatformDb(db.driver);
  const email = claims.email ? normalizeEmail(claims.email) : null;
  const autoLink = !!email && canAutoLink(claims);
  const linked = autoLink ? await db.linkGoogleInvites(claims.sub, email!, now, newId()) : 0;
  if (autoLink) await pdb.link(claims.sub, email!, now, newId());
  const staff = await db.activeStaffForSub(claims.sub);
  const platform = await pdb.hasAccess(claims.sub);
  if (staff.length === 0 && !platform) {
    if (email && !autoLink && ((await db.hasPendingGoogleInvite(email, now)) || (await pdb.hasPendingInvite(email, now)))) {
      return noticeResponse(c, 403, "confirm_needed", { cookies: clear });
    }
    return noticeResponse(c, 403, "no_access", { cookies: clear });
  }
  // Confirm every staff/invite/platform change (including any link just made) in the change log first.
  if (linked > 0 || staff.length > 0 || platform) await flushChangeLog(db, c.var.ledger, now);

  // Organiser or site owner: their own session (cookie) too.
  const cookies = [...clear];
  if (platform) {
    const s = await platformSession(pdb, claims.sub, now);
    if (s === "capped") return noticeResponse(c, 429, "capped", { cookies: clear });
    if (s === "changed") return noticeResponse(c, 403, "changed", { cookies: clear });
    cookies.push(s.cookie);
    if (staff.length === 0) return noticeResponse(c, 200, "signed_in", { refreshTo: "/platform", cookies });
  }

  if (staff.length === 1 && !platform) {
    const s = staff[0]!;
    const token = newToken();
    const ok = await db.createGoogleSession({
      hash: await sha256hex(token), staffId: s.staff_id, partyId: s.party_id, sub: claims.sub, now,
      expiresAt: now + CONFIG.googleSessionMs,
    });
    if (ok === "capped") return noticeResponse(c, 429, "capped", { cookies: clear });
    if (ok !== "created") return noticeResponse(c, 403, "changed", { cookies: clear });
    // A small same-site page navigates on; a 302 straight to the dashboard could drop the Strict cookie.
    return noticeResponse(c, 200, "signed_in", { refreshTo: "/dashboard", cookies: [
      ...clear,
      cookie(COOKIE_SESSION, token, { maxAgeS: CONFIG.googleSessionMs / 1000, sameSite: "Strict" }),
    ] });
  }

  // Staff at several parties: a sealed, 2-minute, Strict cookie holds the verified
  // Google account id until a party is picked. No database write.
  const pick = await seal(envRecord(c), PICK_PURPOSE, { sub: claims.sub }, now + CONFIG.loginGrantMs);
  const forms = staff
    .map((s) => `<form method="post" action="/api/auth/select-party" class="pick"><input type="hidden" name="party_id" value="${escapeHtml(s.party_id)}"><button type="submit" class="btn" data-name="${escapeHtml(s.party_name)}" data-role="${escapeHtml(s.role)}">${escapeHtml(s.party_name)} (${escapeHtml(s.role)})</button></form>`)
    .join("");
  // Also an organiser or site owner (already signed in to that page above): it is one more choice.
  const platformLink = platform ? `<p><a href="/platform" class="btn" data-platform="">Organiser page</a></p>` : "";
  return noticeResponse(c, 200, "choose", { extraHtml: forms + platformLink, cookies: [
    ...cookies,
    cookie(COOKIE_PICK, pick, { maxAgeS: CONFIG.loginGrantMs / 1000, sameSite: "Strict" }),
  ] });
});

// Step 3 (only for accounts at several parties).
authRoutes.post("/select-party", async (c) => {
  const clear = [clearCookie(COOKIE_PICK)];
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return noticeResponse(c, 403, "bad_origin", { cookies: clear });
  const now = c.var.deps.now();
  const sealed = readCookie(c, COOKIE_PICK);
  const pick = sealed ? await unseal(envRecord(c), PICK_PURPOSE, sealed, now) : null;
  const form = await c.req.parseBody();
  const partyId = typeof form.party_id === "string" ? form.party_id : "";
  const sub = typeof pick?.sub === "string" ? pick.sub : null;
  if (!sub || !partyId) {
    return noticeResponse(c, 400, "pick_expired", { cookies: clear });
  }
  const s = (await c.var.db.activeStaffForSub(sub)).find((x) => x.party_id === partyId);
  if (!s) return noticeResponse(c, 400, "pick_expired", { cookies: clear });
  const token = newToken();
  const ok = await c.var.db.createGoogleSession({
    hash: await sha256hex(token), staffId: s.staff_id, partyId, sub, now, expiresAt: now + CONFIG.googleSessionMs,
  });
  if (ok === "capped") return noticeResponse(c, 429, "capped", { cookies: clear });
  if (ok !== "created") return noticeResponse(c, 403, "changed", { cookies: clear });
  return noticeResponse(c, 200, "signed_in", { refreshTo: "/dashboard", cookies: [
    ...clear,
    cookie(COOKIE_SESSION, token, { maxAgeS: CONFIG.googleSessionMs / 1000, sameSite: "Strict" }),
  ] });
});

authRoutes.post("/logout", requireAuth(["owner", "admin", "door"]), async (c) => {
  await c.var.db.revokeSession(c.var.auth.hash, c.var.deps.now());
  const res = json(c, 200, { status: "signed_out" });
  res.headers.append("set-cookie", clearCookie(COOKIE_SESSION));
  return res;
});
