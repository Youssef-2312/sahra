import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PUBLIC_ORIGIN: "https://sahra.test",
            GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            // Test-only master secret (32 zero-ish bytes); real ones are Cloudflare secrets.
            QR_MASTER_K1: "dGVzdC1vbmx5LXFyLW1hc3Rlci1zZWNyZXQtMzItYnl0ZXM",
            ENABLE_PROTO: "1",
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
