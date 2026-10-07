# Checkpoint A: live CPU measurements

Goal: CPU time on real Cloudflare for (1) the complete Google sign-in callback,
including a JWKS cache miss, and (2) the scan path (prototype; the real endpoint is
measured again at Checkpoint B). The sandbox cannot reach Cloudflare, so you run
these steps; send Claude the numbers (or screenshots), never secrets or cookies.

Prerequisites: docs/SETUP.md steps 1 to 5 done, and you are signed in as owner.

## 1. Sign-in with a JWKS cache miss

The Google key cache lives in each Worker isolate's memory. A new deployment starts
new isolates, so the first sign-in after a deploy fetches the keys (a miss).

1. Trigger a fresh deploy: Workers & Pages > sahra > Deployments > latest > Retry
   deployment (or merge any change to `main`).
2. Within a minute, open `https://sahra.<your-subdomain>.workers.dev/` in a private
   window and sign in with Google. Then sign out, and sign in again 3 more times.

## 2. Scan prototype

1. On the dashboard, "Invite door staff": name `checkpoint-a`, 1 hour. Copy the link.
2. On your computer, in the repository folder:

```sh
node scripts/checkpoint-a.mjs --invite "<the link>" --scans 50
```

It joins as that door account, creates 50 test tickets and, for each, scans it
(admit), scans it again (used) and scans a forged code (invalid). It prints verdict
counts and client round-trip latency (which includes your own network).

3. Afterwards revoke that invitation in the dashboard ("revoke invite", invite id
   from the staff list), which also ends the session the script used.

## 3. Read the CPU time

Dashboard: **Workers & Pages > sahra > Observability** (Workers Logs), last 1 hour.
Use the Query Builder:

- Visualization: Calculate `P50`, `P95` and `max` of `$workers.cpuTimeMs`, also of
  `$workers.wallTimeMs`.
- Filter: `$workers.event.request.url` includes `/api/auth/google/callback`;
  group by nothing. Then repeat with `/api/proto/scan` and with `/api/invites/consume`.
- To see the cache miss: open the events for the callback; the custom log line
  `{"evt":"req",...,"jwks":"miss"}` marks requests that fetched Google's keys.
  Note the `$workers.cpuTimeMs` of those events separately.

The same log lines carry `rows_read` and `rows_written` (from D1's own metadata).
Also open **Storage & databases > D1 > sahra-prod > Metrics** for the day's totals.

## What to send back

- Callback CPU ms: each JWKS-miss event, plus P50/P95/max of all.
- Proto scan CPU ms: P50/P95/max (and wall time P95).
- Join (invites/consume) CPU ms: value.
- The script's printed output.
- D1 rows written today (dashboard), and whether any request shows
  "Exceeded CPU Time Limits" under Metrics > Errors.

After Checkpoint A, set `"ENABLE_PROTO": "0"` (Claude does this in Phase 2 when the
prototype is removed).
