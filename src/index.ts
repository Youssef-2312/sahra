import { createApp } from "./app";
import { JwksCache } from "./auth/google";
import type { Env } from "./env";

const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
const app = createApp({ fetch: fetcher, now: () => Date.now(), jwks: new JwksCache(fetcher) });

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
