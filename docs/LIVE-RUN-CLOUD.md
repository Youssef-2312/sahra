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
(cold / first use / warm, samples, p50/p95/p99/max, rows written per request),
then the slowest warm requests with their isolate request number, endpoint
request number and how many requests were running at once. Report it to the owner.

The token cannot read or change D1 (by design), so the run ends with two
staging-only endpoints that the Worker itself serves (404 in production):

- **Ledger check** (`GET /api/test/ledger-check`, same check as setup.bat step 11):
  every admission of the party has its ledger record. It prints a PASS/FAIL line.
- **Cleanup** (`POST /api/test/revoke-door-access`, same as setup.bat step 13):
  revokes every door invitation and ends every door session of the party, writes
  the change log for every revoked invitation (also any earlier one not yet
  recorded), and ends its own session last.

## Recovery rehearsal (Checkpoint C, docs/SETUP.md part E)

```sh
node scripts/live-check.mjs --invite "<link 1>" --save before.json   # report the time it prints
node scripts/live-check.mjs --invite "<link 2>" --save after.json
# ... the owner runs setup.bat step 20 (restore to the time from link 1) ...
node -e 'const f=require("fs");const a=JSON.parse(f.readFileSync("before.json"));const b=JSON.parse(f.readFileSync("after.json"));f.writeFileSync("all.json",JSON.stringify({tickets:[...a.tickets,...b.tickets]}))'
node scripts/live-check.mjs --invite "<link 3>" --verify-used all.json
```

Every saved ticket must say "used" and the ledger check must report
`nothing_reopened`. The saved files hold staging test codes only; never commit them.
