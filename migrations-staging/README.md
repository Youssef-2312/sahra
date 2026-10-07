# Staging-only SQL

Tables that exist only in the staging databases (today: the Checkpoint A scan
prototype). Production never gets them. These files are not tracked by
`wrangler d1 migrations`; they use `CREATE TABLE IF NOT EXISTS`, so applying them
again is harmless. Apply with `setup.bat` (option "staging-only tables") or:

```sh
npx wrangler d1 execute DB --remote --env staging --file migrations-staging/main/0001_proto.sql
npx wrangler d1 execute LEDGER --remote --env staging --file migrations-staging/ledger/0001_proto.sql
```
