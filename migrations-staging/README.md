# Staging-only SQL

SQL that runs only on the staging databases. Production never gets it. Today:
removing the Phase 1 Checkpoint A prototype tables. These files are not tracked by
`wrangler d1 migrations`; they use `IF EXISTS` / `IF NOT EXISTS`, so applying them again is harmless. Apply with `setup.bat` (option "staging-only tables") or:

```sh
npx wrangler d1 execute DB --remote --env staging --file migrations-staging/main/0002_drop_proto.sql
npx wrangler d1 execute LEDGER --remote --env staging --file migrations-staging/ledger/0002_drop_proto.sql
```
