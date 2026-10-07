import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const ledgerMigrations = await readD1Migrations("./migrations-ledger");
  // Staging-only SQL is applied too (it must be harmless on any database).
  const stagingMain = await readD1Migrations("./migrations-staging/main");
  const stagingLedger = await readD1Migrations("./migrations-staging/ledger");
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
            PUBLIC_ORIGIN: "https://sahra.test",
            GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            // Test-only master secrets; real ones are Cloudflare secrets.
            QR_MASTER_K1: "dGVzdC1vbmx5LXFyLW1hc3Rlci1zZWNyZXQtMzItYnl0ZXM",
            COOKIE_MASTER_K1: "dGVzdC1vbmx5LWNvb2tpZS1tYXN0ZXItc2VjcmV0LTMyYg",
            // A second key id, to test that old-key cookies stop working once removed.
            COOKIE_MASTER_K2: "dGVzdC1vbmx5LWNvb2tpZS1tYXN0ZXItc2VjcmV0LWsyLTMyYg",
            ENABLE_TEST_TICKETS: "1",
          },
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
