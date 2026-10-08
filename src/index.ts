import { createApp, resetRequestCounters } from "./app";
import { JwksCache } from "./auth/google";
import { D1Driver } from "./db/driver";
import { scheduledSend } from "./email/sender";
import { cfConnect } from "./email/socket";
import type { Env } from "./env";
import { warmUp } from "./warmup";

const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
const app = createApp({ fetch: fetcher, now: () => Date.now(), jwks: new JwksCache(fetcher) });
// Runs the hot code paths once at startup, against an in-memory stand-in (src/warmup.ts).
await warmUp(app, resetRequestCounters);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  // Once a minute: send a few due outbox emails (src/email/sender.ts).
  scheduled: (_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(scheduledSend(env, new D1Driver(env.DB), { now: () => Date.now(), random: Math.random, connect: cfConnect, fetch: fetcher }));
  },
} satisfies ExportedHandler<Env>;
