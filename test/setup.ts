import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.LEDGER, env.TEST_LEDGER_MIGRATIONS);
await applyD1Migrations(env.FILES!, env.TEST_FILES_MIGRATIONS);
await applyD1Migrations(env.FILES_2!, env.TEST_FILES_MIGRATIONS);
// Staging-only tables (applied with d1 execute, not tracked as migrations); safe to repeat.
for (const [db, ms] of [[env.DB, env.TEST_STAGING_MAIN], [env.LEDGER, env.TEST_STAGING_LEDGER]] as const) {
  for (const m of ms) for (const q of m.queries) await db.prepare(q).run();
}
