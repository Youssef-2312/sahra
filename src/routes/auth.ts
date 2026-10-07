import { Hono } from "hono";
import { json, requireAuth, type AppEnv, type Ctx } from "../context";
import { authUrl, canAutoLink, exchangeCode, normalizeEmail, pkceChallenge, verifyIdToken, AuthError } from "../auth/google";
import { flushChangeLog } from "../changelog";
import { CONFIG } from "../env";
import { newId, newToken, parseToken, seal, sha256hex, timingSafeEqualStr, unseal } from "../lib/crypto";
import {
  COOKIE_LOGIN,
  COOKIE_PICK,
  COOKIE_SESSION,
  clearCookie,
  clientIp,
  cookie,
  escapeHtml,
  page,
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

function htmlPage(c: Ctx, status: number, title: string, body: string, refreshTo?: string, cookies: string[] = []) {
  const res = c.html(page(title, body, refreshTo), status as 200);
  for (const ck of cookies) res.headers.append("set-cookie", ck);
  return res;
}

const tryAgain = `<p><a href="/">Back to sign in</a></p>`;

const LOGIN_PURPOSE = "login-attempt";
const PICK_PURPOSE = "party-pick";

// Step 1: our sign-in page POSTs here (a form). Nothing is written to the database:
// state, nonce and the PKCE verifier travel in a sealed (AES-GCM, key id, expiry),
// short-lived Lax cookie, and the browser goes to Google.
authRoutes.post("/google/start", async (c) => {
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c, 403, { error: "bad_origin" });
  if (await rateLimited(c.env.RL_AUTH, `login:${clientIp(c)}`)) return json(c, 429, { error: "rate_limited" });
  const now = c.var.deps.now();
  const state = newToken();
  const nonce = newToken();
  const codeVerifier = newToken();
  const sealed = await seal(envRecord(c), LOGIN_PURPOSE, { s: state, n: nonce, v: codeVerifier }, now + CONFIG.loginAttemptMs);
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
});

// Step 2: Google redirects back here. The sealed cookie must exist, be genuine and
// unexpired, and hold the same state as the URL (this binds the sign-in to the
// browser that started it). The code is exchanged and the ID token fully verified
// BEFORE any database access. Single use comes from Google's one-time code and the
// nonce check; the cookie is cleared on every outcome.
authRoutes.get("/google/callback", async (c) => {
  const clear = [clearCookie(COOKIE_LOGIN, "Lax")];
  if (await rateLimited(c.env.RL_AUTH, `callback:${clientIp(c)}`)) {
    return htmlPage(c, 429, "Too many attempts", `<p>Too many sign-in attempts. Wait a minute and try again.</p>${tryAgain}`, undefined, clear);
  }
  if (c.req.query("error")) {
    return htmlPage(c, 400, "Sign-in cancelled", `<p>Sign-in was cancelled.</p>${tryAgain}`, undefined, clear);
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
    return htmlPage(c, 400, "Sign-in failed", `<p>This sign-in did not start in this browser, or it expired. Start again.</p>${tryAgain}`, undefined, clear);
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
    return htmlPage(c, 401, "Sign-in failed", `<p>Google sign-in could not be verified (${escapeHtml(codeName)}).</p>${tryAgain}`, undefined, clear);
  }

  // From here on the request carries a verified Google identity. Writes happen
  // only if that identity matches a pending invitation or is active staff.
  const db = c.var.db;
  const email = claims.email ? normalizeEmail(claims.email) : null;
  const linked = email && canAutoLink(claims) ? await db.linkGoogleInvites(claims.sub, email, now, newId()) : 0;
  const staff = await db.activeStaffForSub(claims.sub);
  if (staff.length === 0) {
    if (email && !canAutoLink(claims) && (await db.hasPendingGoogleInvite(email, now))) {
      return htmlPage(c, 403, "Confirmation needed",
        `<p>You were invited with an address that is not Gmail or Google Workspace. Such addresses must be confirmed by email, which is not available yet. Ask the party owner to invite a Gmail address instead.</p>${tryAgain}`,
        undefined, clear);
    }
    return htmlPage(c, 403, "No access", `<p>This Google account is not staff at any party.</p>${tryAgain}`, undefined, clear);
  }
  // Confirm every staff/invite change (including any link just made) in the change log first.
  if (linked > 0 || staff.length > 0) await flushChangeLog(db, c.var.ledger, now);

  if (staff.length === 1) {
    const s = staff[0]!;
    const token = newToken();
    const ok = await db.createGoogleSession({
      hash: await sha256hex(token), staffId: s.staff_id, partyId: s.party_id, sub: claims.sub, now,
      expiresAt: now + CONFIG.googleSessionMs,
    });
    if (!ok) return htmlPage(c, 403, "No access", `<p>Access changed during sign-in. Try again.</p>${tryAgain}`, undefined, clear);
    // A small same-site page navigates on; a 302 straight to the dashboard could drop the Strict cookie.
    return htmlPage(c, 200, "Signed in", `<p>Signed in. <a href="/dashboard">Continue</a></p>`, "/dashboard", [
      ...clear,
      cookie(COOKIE_SESSION, token, { maxAgeS: CONFIG.googleSessionMs / 1000, sameSite: "Strict" }),
    ]);
  }

  // Staff at several parties: a sealed, 5-minute, Strict cookie holds the verified
  // Google account id until a party is picked. No database write.
  const pick = await seal(envRecord(c), PICK_PURPOSE, { sub: claims.sub }, now + CONFIG.loginGrantMs);
  const forms = staff
    .map((s) => `<form method="post" action="/api/auth/select-party"><input type="hidden" name="party_id" value="${escapeHtml(s.party_id)}"><button type="submit">${escapeHtml(s.party_name)} (${escapeHtml(s.role)})</button></form>`)
    .join("");
  return htmlPage(c, 200, "Choose party", `<p>Choose a party:</p>${forms}`, undefined, [
    ...clear,
    cookie(COOKIE_PICK, pick, { maxAgeS: CONFIG.loginGrantMs / 1000, sameSite: "Strict" }),
  ]);
});

// Step 3 (only for accounts at several parties).
authRoutes.post("/select-party", async (c) => {
  const clear = [clearCookie(COOKIE_PICK)];
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c, 403, { error: "bad_origin" });
  const now = c.var.deps.now();
  const sealed = readCookie(c, COOKIE_PICK);
  const pick = sealed ? await unseal(envRecord(c), PICK_PURPOSE, sealed, now) : null;
  const form = await c.req.parseBody();
  const partyId = typeof form.party_id === "string" ? form.party_id : "";
  const sub = typeof pick?.sub === "string" ? pick.sub : null;
  if (!sub || !partyId) {
    return htmlPage(c, 400, "Sign-in failed", `<p>Party choice expired. Sign in again.</p>${tryAgain}`, undefined, clear);
  }
  const s = (await c.var.db.activeStaffForSub(sub)).find((x) => x.party_id === partyId);
  if (!s) return htmlPage(c, 400, "Sign-in failed", `<p>Party choice expired. Sign in again.</p>${tryAgain}`, undefined, clear);
  const token = newToken();
  const ok = await c.var.db.createGoogleSession({
    hash: await sha256hex(token), staffId: s.staff_id, partyId, sub, now, expiresAt: now + CONFIG.googleSessionMs,
  });
  if (!ok) return htmlPage(c, 403, "No access", `<p>Access changed during sign-in. Try again.</p>${tryAgain}`, undefined, clear);
  return htmlPage(c, 200, "Signed in", `<p>Signed in. <a href="/dashboard">Continue</a></p>`, "/dashboard", [
    ...clear,
    cookie(COOKIE_SESSION, token, { maxAgeS: CONFIG.googleSessionMs / 1000, sameSite: "Strict" }),
  ]);
});

authRoutes.post("/logout", requireAuth(["owner", "admin", "door"]), async (c) => {
  await c.var.db.revokeSession(c.var.auth.hash, c.var.deps.now());
  const res = json(c, 200, { status: "signed_out" });
  res.headers.append("set-cookie", clearCookie(COOKIE_SESSION));
  return res;
});
