import type { Context, MiddlewareHandler } from "hono";
import type { Fetcher, JwksCache } from "./auth/google";
import type { Db, Role, SessionInfo } from "./db";
import type { Env } from "./env";
import { csrfFor, parseToken, sha256hex, timingSafeEqualStr } from "./lib/crypto";
import { COOKIE_SESSION, readCookie, sameOrigin } from "./lib/http";
import type { ObjectStore } from "./storage";

export interface Deps {
  fetch: Fetcher;
  now: () => number;
  jwks: JwksCache;
  /** Wraps the object store (tests use this to inject failures). */
  store?: (env: Env) => ObjectStore;
}

export interface Auth {
  token: Uint8Array;
  tokenStr: string;
  hash: string;
  info: SessionInfo;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { db: Db; store: ObjectStore; deps: Deps; auth: Auth; jwks: "hit" | "miss" | "none" };
};
export type Ctx = Context<AppEnv>;

export function json(c: Ctx, status: number, body: unknown) {
  return c.json(body as object, status as 200);
}

/** Requires a valid session with one of `roles`; for non-GET also same Origin and CSRF header. */
export function requireAuth(roles: readonly Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = readCookie(c, COOKIE_SESSION);
    const token = raw ? parseToken(raw) : null;
    if (!raw || !token) return json(c, 401, { error: "not_signed_in" });
    const hash = await sha256hex(raw);
    const info = await c.var.db.getSession(hash, c.var.deps.now());
    if (!info) return json(c, 401, { error: "not_signed_in" });
    if (!roles.includes(info.role)) return json(c, 403, { error: "forbidden" });
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c, 403, { error: "bad_origin" });
      const sent = c.req.header("x-sahra-csrf") ?? "";
      if (!timingSafeEqualStr(sent, await csrfFor(token))) return json(c, 403, { error: "bad_csrf" });
    }
    c.set("auth", { token, tokenStr: raw, hash, info });
    await next();
  };
}

export async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return null;
  try {
    const v = await c.req.json();
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

