# Live run from a Claude cloud session (staging only)

For a Claude Code cloud session whose environment has:

- network access that allows `sahra-staging.youssefwaelkabbeel.workers.dev` and
  `api.cloudflare.com` (the owner set full access);
- environment variables `CLOUDFLARE_API_TOKEN` (Account > Workers Tail > Read
  ONLY: it must not have D1 or any edit permission) and `CLOUDFLARE_ACCOUNT_ID`.

Rules: staging only (`live-check.mjs` refuses other hosts); never touch
production, its databases, or anything Halloween-26; never print the token.
The owner supplies a fresh 1-hour door invitation link from the staging
dashboard, and opens admission there first.

```sh
git fetch origin claude/eager-fermi-4hp8lg && git checkout claude/eager-fermi-4hp8lg
npm ci
test -n "$CLOUDFLARE_API_TOKEN" && echo token-present
# Node does not use the session proxy by default; this makes fetch go through it.
export NODE_USE_ENV_PROXY=1 NODE_NO_WARNINGS=1
node scripts/measure-cpu.mjs --auto --invite "<link from the owner>"
```

It prints the PASS/FAIL lines of the live checks and the CPU table per endpoint
(cold / first use / warm, samples, p50/p95/p99/max, rows written per request).
Report it to the owner. The ledger check (setup.bat step 11) needs the owner's
own Cloudflare login and stays on the owner's computer.
