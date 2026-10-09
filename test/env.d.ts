import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_ASSET_HEADERS: string;
      TEST_SITE_CSS: string;
      TEST_LEDGER_MIGRATIONS: D1Migration[];
      TEST_STAGING_MAIN: D1Migration[];
      TEST_STAGING_LEDGER: D1Migration[];
      TEST_FILES_MIGRATIONS: D1Migration[];
      COOKIE_MASTER_K2: string;
      RL_TEST: RateLimit;
      RESTORE_MAIN: D1Database;
      RESTORE_LEDGER: D1Database;
      RESTORE_FILES: D1Database;
      RESTORE_FILES_2: D1Database;
    }
  }
}
