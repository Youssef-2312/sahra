# Sahra

Multi-party ticket platform for private, non-commercial house parties. Backend only
for now (Cloudflare Workers + D1, Hono, TypeScript; no R2); the pages in `public/` are
bare test pages until the frontend design stage.

Status: **Phase 1 (authentication)**: Google sign-in for owners/admins, one-time
invitations for door staff, sessions, change log for staff and invitation changes.

## Layout

| Path | What |
|---|---|
| `src/db/` | All database access (`driver.ts` is the only D1-specific file; `index.ts` holds every SQL rule). |
| `src/ledger/` | The ledger: records kept in a separate D1 database (`sahra-ledger`) so a restore of the main database cannot erase them. |
| `src/auth/google.ts` | Google authorization-code flow (state, nonce, PKCE) and ID token verification. |
| `src/changelog.ts` | Writes each changed row's full state to the ledger under entity + rev before a change is confirmed. |
| `src/routes/` | HTTP endpoints. `proto.ts` is a temporary scan prototype for Checkpoint A. |
| `migrations/`, `migrations-ledger/` | Schemas of the main and ledger databases (applied by the owner, never by deploys). |
| `public/` | Static test pages (served as Workers static assets; they do not invoke the Worker). |
| `scripts/` | Operator tools run on the owner's computer (create a party, generate a secret, Checkpoint A driver). |
| `docs/SETUP.md` | Owner's setup steps, migrations rule and Checkpoint A. |

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
- A change is confirmed to the user only after its change-log entry is confirmed in the ledger.
- Requests without a session write nothing, except door join with a valid invitation (and, in Phase 4, Turnstile-protected guest sign-up). `test/unauth.test.ts` checks every route.
- All restores go through the controlled recovery procedure (Phase 3).
