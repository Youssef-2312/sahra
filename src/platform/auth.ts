// Platform sign-in (site owners and organisers) and the platform session
// check. Same mechanisms as party staff (src/routes/auth.ts, src/context.ts):
// Google sign-in with state, nonce and PKCE in a sealed cookie, no database
// write before a valid Google response, the same auto-link rules, a read-only
// hourly session cap, sessions stored as SHA-256 of a 256-bit token in an
// HttpOnly Secure SameSite=Strict __Host- cookie, Origin + CSRF on every change.
// Platform sessions live in their own table and cookie, so a party staff token
// is never accepted by a platform route and the other way round.

import type { Context, MiddlewareHandler } from "hono";
import { canAutoLink, normalizeEmail, type GoogleClaims } from "../auth/google";
import { flushChangeLog } from "../changelog";
import { json, type AppEnv } from "../context";
import { CONFIG } from "../env";
import { csrfFor, newId, newToken, parseToken, sha256hex, timingSafeEqualStr } from "../lib/crypto";
import { cookie, readCookie, sameOrigin } from "../lib/http";
import { noticeResponse, type NoticeKey } from "../auth/notices";
import { PlatformDb, type PlatformRole, type PlatformSession } from "./db";

export const COOKIE_PLATFORM = "__Host-sahra_p";

export interface PlatformAuth {
  token: Uint8Array;
  hash: string;
  info: PlatformSession;
}

export type PlatformEnv = {
  Bindings: AppEnv["Bindings"];
  Variables: AppEnv["Variables"] & { pdb: PlatformDb; platform: PlatformAuth };
};
export type PCtx = Context<PlatformEnv>;

/** Requires a valid platform session whose account currently holds one of `roles`; for non-GET also same Origin and CSRF. */
export function requirePlatform(roles: readonly PlatformRole[]): MiddlewareHandler<PlatformEnv> {
  return async (c, next) => {
    const raw = readCookie(c, COOKIE_PLATFORM);
    const token = raw ? parseToken(raw) : null;
    if (!raw || !token) return json(c as never, 401, { error: "not_signed_in" });
    const pdb = new PlatformDb(c.var.db.driver);
    const hash = await sha256hex(raw);
    const info = await pdb.getSession(hash, c.var.deps.now());
    if (!info) return json(c as never, 401, { error: "not_signed_in" });
    const has = (r: PlatformRole) => (r === "site_owner" ? !!info.site_owner_id : !!info.organiser_id);
    if (!roles.some(has)) return json(c as never, 403, { error: "forbidden" });
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c as never, 403, { error: "bad_origin" });
      const sent = c.req.header("x-sahra-csrf") ?? "";
      if (!timingSafeEqualStr(sent, await csrfFor(token))) return json(c as never, 403, { error: "bad_csrf" });
    }
    c.set("pdb", pdb);
    c.set("platform", { token, hash, info });
    await next();
  };
}

/**
 * Callback half of a platform sign-in, after the Google ID token has been fully
 * verified (src/routes/auth.ts). Writes only if the verified account matches a
 * pending site owner row or organiser invitation, or is already active.
 */
export async function platformCallback(c: Context<AppEnv>, claims: GoogleClaims, clear: string[]) {
  const html = (status: number, key: NoticeKey, refreshTo?: string, cookies: string[] = []) =>
    noticeResponse(c, status, key, { back: "/platform", backLabel: "Back to platform sign in", refreshTo, cookies: [...clear, ...cookies] });
  const now = c.var.deps.now();
  const pdb = new PlatformDb(c.var.db.driver);
  const email = claims.email ? normalizeEmail(claims.email) : null;
  const autoLink = !!email && canAutoLink(claims);
  if (autoLink) await pdb.link(claims.sub, email!, now, newId());
  if (!(await pdb.hasAccess(claims.sub))) {
    if (email && !autoLink && (await pdb.hasPendingInvite(email, now))) {
      return html(403, "p_confirm_needed");
    }
    return html(403, "p_no_access");
  }
  // Confirm every link (including one made by an earlier attempt whose log write
  // failed) in the change log before handing out a session.
  await flushChangeLog(c.var.db, c.var.ledger, now);
  const s = await platformSession(pdb, claims.sub, now);
  if (s === "capped") return html(429, "capped");
  if (s === "changed") return html(403, "changed");
  return html(200, "signed_in", "/platform", [s.cookie]);
}

/**
 * A new platform session for a verified Google account that has platform access
 * (the caller linked invitations and flushed the change log): its cookie, or why not.
 * Also used by the single "Continue with Google" sign-in (src/routes/auth.ts).
 */
export async function platformSession(pdb: PlatformDb, sub: string, now: number): Promise<{ cookie: string } | "capped" | "changed"> {
  const token = newToken();
  const ok = await pdb.createSession({ hash: await sha256hex(token), sub, now, expiresAt: now + CONFIG.googleSessionMs });
  if (ok === "capped") return "capped";
  if (ok !== "created") return "changed";
  return { cookie: cookie(COOKIE_PLATFORM, token, { maxAgeS: CONFIG.googleSessionMs / 1000, sameSite: "Strict" }) };
}
