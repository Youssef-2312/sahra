# Sahra

Multi-party ticket platform for private, non-commercial house parties. Backend only
for now (Cloudflare Workers + D1 + R2, Hono, TypeScript); the pages in `public/` are
bare test pages until the frontend design stage.

Status: **Phase 1 (authentication)**: Google sign-in for owners/admins, one-time
invitations for door staff, sessions, change log for staff and invitation changes.

## Layout

| Path | What |
|---|---|
| `src/db/` | All database access (`driver.ts` is the only D1-specific file; `index.ts` holds every SQL rule). |
| `src/storage/` | All object storage (R2). |
| `src/auth/google.ts` | Google authorization-code flow (state, nonce, PKCE) and ID token verification. |
| `src/changelog.ts` | Writes each changed row's full state to R2 under entity + rev before a change is confirmed. |
| `src/routes/` | HTTP endpoints. `proto.ts` is a temporary scan prototype for Checkpoint A. |
| `migrations/` | D1 schema. |
| `public/` | Static test pages (served as Workers static assets; they do not invoke the Worker). |
| `scripts/` | Operator tools run on the owner's computer (create a party, generate a secret, Checkpoint A driver). |
| `docs/` | Setup and checkpoint instructions. |

## Develop

```sh
npm ci
npm test          # Vitest inside workerd (@cloudflare/vitest-pool-workers)
npm run typecheck
```

## Rules this code keeps

- Every rule that decides whether a change is allowed, including "is this session
  still valid", is inside the SQL statement that makes the change.
- No passwords anywhere. Session and invitation tokens are 256-bit random values;
  only their SHA-256 is stored.
- A change is confirmed to the user only after its change-log entry is confirmed in R2.
- All restores go through the controlled recovery procedure (Phase 3).
