import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_LEDGER_MIGRATIONS: D1Migration[];
      TEST_STAGING_MAIN: D1Migration[];
      TEST_STAGING_LEDGER: D1Migration[];
      COOKIE_MASTER_K2: string;
      RL_TEST: RateLimit;
    }
  }
}
