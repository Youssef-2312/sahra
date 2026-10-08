import { createApp, resetRequestCounters } from "./app";
import { JwksCache } from "./auth/google";
import { D1Driver } from "./db/driver";
import { scheduledSend } from "./email/sender";
import { cfConnect } from "./email/socket";
import type { Env } from "./env";
import { dbSizes, isHealthMinute, runHealth } from "./health";
import { purgeOldScreenshots } from "./storage";
import { warmUp } from "./warmup";

const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
const app = createApp({ fetch: fetcher, now: () => Date.now(), jwks: new JwksCache(fetcher) });
// Runs the hot code paths once at startup, against an in-memory stand-in (src/warmup.ts).
await warmUp(app, resetRequestCounters);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  // Once a minute: send a few due outbox emails (src/email/sender.ts). Every 15
  // minutes, separately: the health checks (src/health/).
  scheduled: (ctrl: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // A controlled recovery is running (scripts/recover.mjs): no database writes.
    if (env.MAINTENANCE === "1") return;
    ctx.waitUntil(scheduledSend(env, new D1Driver(env.DB), { now: () => Date.now(), random: Math.random, connect: cfConnect, fetch: fetcher }));
    if (isHealthMinute(ctrl.scheduledTime)) {
      ctx.waitUntil(runHealth({
        main: new D1Driver(env.DB), ledger: new D1Driver(env.LEDGER), now: () => Date.now(), sizes: () => dbSizes(env),
        maintenance: env.MAINTENANCE === "1", emailConfigured: !!((env.GMAIL_ADDRESS && env.GMAIL_APP_PASSWORD) || (env.BREVO_API_KEY && env.BREVO_SENDER)),
        origin: env.PUBLIC_ORIGIN, discordUrl: env.DISCORD_WEBHOOK_URL, fetch: fetcher,
        purgeScreenshots: (now) => purgeOldScreenshots(env, new D1Driver(env.DB), now),
      }));
    }
  },
} satisfies ExportedHandler<Env>;
