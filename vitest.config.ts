import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const ledgerMigrations = await readD1Migrations("./migrations-ledger");
  // Staging-only SQL is applied too (it must be harmless on any database).
  const stagingMain = await readD1Migrations("./migrations-staging/main");
  const stagingLedger = await readD1Migrations("./migrations-staging/ledger");
  const filesMigrations = await readD1Migrations("./migrations-files");
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_ASSET_HEADERS: readFileSync("./public/_headers", "utf8"),
            TEST_LEDGER_MIGRATIONS: ledgerMigrations,
            TEST_STAGING_MAIN: stagingMain,
            TEST_STAGING_LEDGER: stagingLedger,
            TEST_FILES_MIGRATIONS: filesMigrations,
            PUBLIC_ORIGIN: "https://sahra.test",
            GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            // Test-only master secrets; real ones are Cloudflare secrets.
            QR_MASTER_K1: "dGVzdC1vbmx5LXFyLW1hc3Rlci1zZWNyZXQtMzItYnl0ZXM",
            COOKIE_MASTER_K1: "dGVzdC1vbmx5LWNvb2tpZS1tYXN0ZXItc2VjcmV0LTMyYg",
            // A second key id, to test that old-key cookies stop working once removed.
            COOKIE_MASTER_K2: "dGVzdC1vbmx5LWNvb2tpZS1tYXN0ZXItc2VjcmV0LWsyLTMyYg",
            LINK_MASTER_K1: "dGVzdC1vbmx5LWxpbmstbWFzdGVyLXNlY3JldC0zMi1ieXRlcw",
            BACKUP_KEY: "dGVzdC1vbmx5LWJhY2t1cC1zaWduaW5nLWtleS0zMi1ieXRlcw",
            // Cloudflare's documented Turnstile test keys (always pass); accepted only
            // where ENABLE_TEST_TICKETS = "1". Tests answer siteverify with a fake.
            TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
            TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
            ENABLE_TEST_TICKETS: "1",
          },
          // Test-only: the real files databases (sahra-files-N) do not exist yet. RESTORE_*:
          // fresh databases the backup tests restore into (src/backup/restore.ts).
          d1Databases: { FILES: "test-files", FILES_2: "test-files-2", RESTORE_MAIN: "test-restore-main", RESTORE_LEDGER: "test-restore-ledger", RESTORE_FILES: "test-restore-files", RESTORE_FILES_2: "test-restore-files-2" },
          // Generous limits for the functional tests; RL_TEST checks limiting itself.
          ratelimits: {
            RL_AUTH: { namespace_id: "91001", simple: { limit: 100000, period: 60 } },
            RL_SCAN: { namespace_id: "91002", simple: { limit: 100000, period: 60 } },
            RL_TEST: { namespace_id: "91003", simple: { limit: 3, period: 60 } },
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
