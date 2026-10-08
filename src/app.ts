import { Hono } from "hono/tiny";
import { AuthError } from "./auth/google";
import { LogPendingError } from "./changelog";
import { json, requireAuth, type AppEnv, type Deps } from "./context";
import { D1Driver } from "./db/driver";
import { Db } from "./db";
import { MissingSecretError, csrfFor } from "./lib/crypto";
import { SECURITY_HEADERS } from "./lib/http";
import { D1Ledger } from "./ledger";
import { authRoutes } from "./routes/auth";
import { inviteRoutes } from "./routes/invites";
import { staffRoutes } from "./routes/staff";
import { scanRoutes } from "./routes/scan";
import { admissionRoutes } from "./routes/admission";
import { testingRoutes } from "./routes/testing";
import { guestRoutes } from "./routes/guests";
import { ticketRoutes } from "./routes/tickets";

export type { Deps } from "./context";

// Per-isolate request counter: request 1 of an isolate is "cold" (first use of
// code paths, caches empty); later ones are "warm". Logged with every request so
// CPU time can be reported separately for cold and warm requests.
let isolateRequests = 0;
let isolateStartedAt = 0;
// Requests running in this isolate right now (several can interleave while one
// waits for the database); logged to explain slow outliers.
let inFlight = 0;
// Per-isolate, per-endpoint counter: request 1 of an endpoint in a warm isolate is
// that code path's first use (lazy compilation, first key import), reported apart.
const routeRequests = new Map<string, number>();

/** After the startup warm-up (src/warmup.ts): its requests are not counted. */
export function resetRequestCounters() {
  isolateRequests = 0;
  isolateStartedAt = 0;
  inFlight = 0;
  routeRequests.clear();
}

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const started = Date.now();
    isolateRequests++;
    if (isolateStartedAt === 0) isolateStartedAt = started;
    const isoReq = isolateRequests;
    const concurrent = ++inFlight;
    const mainDriver = new D1Driver(c.env.DB);
    const driver = deps.driver ? deps.driver(mainDriver, "main") : mainDriver;
    c.set("db", new Db(driver));
    const baseLedgerDriver = new D1Driver(c.env.LEDGER);
    const ledgerDriver = deps.driver ? deps.driver(baseLedgerDriver, "ledger") : baseLedgerDriver;
    const ledger = new D1Ledger(ledgerDriver);
    c.set("ledgerDriver", ledgerDriver);
    c.set("ledger", deps.ledger ? deps.ledger(ledger) : ledger);
    c.set("deps", deps);
    deps.jwks.lastLookup = "none";
    try {
      await next();
    } finally {
      inFlight--;
    }
    const routeKey = `${c.req.method} ${c.req.routePath}`;
    const routeReq = (routeRequests.get(routeKey) ?? 0) + 1;
    routeRequests.set(routeKey, routeReq);
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
        ledger_rows_written: ledgerDriver.usage.rows_written,
        jwks: deps.jwks.lastLookup,
        iso_req: isoReq,
        cold: isoReq === 1,
        route_req: routeReq,
        iso_age_ms: started - isolateStartedAt,
        in_flight: concurrent,
        wall_ms: Date.now() - started,
      }),
    );
  });

  app.onError((err, c) => {
    if (err instanceof LogPendingError) {
      return json(c, 503, { status: "pending", error: "not_recorded_yet", retry: true });
    }
    if (err instanceof AuthError) return json(c, 401, { error: err.code });
    if (/D1_|Network connection lost/.test(String((err as Error)?.message ?? ""))) {
      // Database unreachable or failing: never a success; clients show "can't verify" / retry.
      console.error(JSON.stringify({ evt: "db_error", message: String((err as Error).message) }));
      return json(c, 503, { error: "database_unavailable", retry: true });
    }
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
  app.route("/api/scan", scanRoutes);
  app.route("/api/admission", admissionRoutes);
  app.route("/api/test", testingRoutes);
  app.route("/api/guest", guestRoutes);
  app.route("/api/tickets", ticketRoutes);

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
