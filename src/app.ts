import { Hono } from "hono";
import { AuthError } from "./auth/google";
import { LogPendingError } from "./changelog";
import { json, requireAuth, type AppEnv, type Deps } from "./context";
import { D1Driver } from "./db/driver";
import { Db } from "./db";
import { MissingSecretError, csrfFor } from "./lib/crypto";
import { SECURITY_HEADERS } from "./lib/http";
import { R2Store } from "./storage";
import { authRoutes } from "./routes/auth";
import { inviteRoutes } from "./routes/invites";
import { staffRoutes } from "./routes/staff";
import { protoRoutes } from "./routes/proto";

export type { Deps } from "./context";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const started = Date.now();
    const driver = new D1Driver(c.env.DB);
    c.set("db", new Db(driver));
    c.set("store", deps.store ? deps.store(c.env) : new R2Store(c.env.BUCKET));
    c.set("deps", deps);
    deps.jwks.lastLookup = "none";
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    // One structured line per request, for Workers Logs (CPU time is on the invocation log).
    console.log(
      JSON.stringify({
        evt: "req",
        route: c.req.routePath,
        method: c.req.method,
        status: c.res.status,
        d1_queries: driver.usage.queries,
        rows_read: driver.usage.rows_read,
        rows_written: driver.usage.rows_written,
        jwks: deps.jwks.lastLookup,
        wall_ms: Date.now() - started,
      }),
    );
  });

  app.onError((err, c) => {
    if (err instanceof LogPendingError) {
      return json(c, 503, { status: "pending", error: "not_recorded_yet", retry: true });
    }
    if (err instanceof AuthError) return json(c, 401, { error: err.code });
    if (err instanceof MissingSecretError) {
      console.error(JSON.stringify({ evt: "config_error", message: err.message }));
      return json(c, 500, { error: "server_not_configured" });
    }
    console.error(JSON.stringify({ evt: "error", message: String(err?.message ?? err) }));
    return json(c, 500, { error: "server_error" });
  });

  app.route("/api/auth", authRoutes);
  app.route("/api/invites", inviteRoutes);
  app.route("/api/staff", staffRoutes);
  app.route("/api/proto", protoRoutes);

  app.get("/api/me", requireAuth(["owner", "admin", "door"]), async (c) => {
    const a = c.var.auth;
    return json(c, 200, {
      party: { id: a.info.party_id, name: a.info.party_name },
      staff: { id: a.info.staff_id, name: a.info.staff_name, role: a.info.role },
      kind: a.info.kind,
      expires_at: a.info.expires_at,
      csrf: await csrfFor(a.token),
    });
  });

  app.notFound((c) => json(c, 404, { error: "not_found" }));
  return app;
}
