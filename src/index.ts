import { createApp, resetRequestCounters } from "./app";
import { JwksCache } from "./auth/google";
import type { Env } from "./env";
import { warmUp } from "./warmup";

const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
const app = createApp({ fetch: fetcher, now: () => Date.now(), jwks: new JwksCache(fetcher) });
// Runs the hot code paths once at startup, against an in-memory stand-in (src/warmup.ts).
await warmUp(app, resetRequestCounters);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
