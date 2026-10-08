// Fresh LOCAL D1 databases (main, ledger, files) in a new directory, for the
// restore drill and the local backup test. Migrations are applied with
// `wrangler d1 migrations apply --local --persist-to <dir>` against a temporary
// config naming only these three local databases; the same persisted SQLite files
// are then opened through Miniflare's D1 binding (what `wrangler d1 execute
// --local` does), so values, BLOBs included, are bound as parameters. Never --remote.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const LOCAL_IDS = {
  DB: "00000000-0000-4000-8000-00000000d001",
  LEDGER: "00000000-0000-4000-8000-00000000d002",
  FILES: "00000000-0000-4000-8000-00000000d003",
};

const MIGRATIONS = { DB: "migrations", LEDGER: "migrations-ledger", FILES: "migrations-files" };

export function npx(root, args, opts = {}) {
  const win = process.platform === "win32";
  return execFileSync(win ? "npx.cmd" : "npx", args, {
    cwd: root, encoding: "utf8", shell: win, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}

/** Creates <dir>/wrangler.json and applies every migration to fresh local databases in <dir>/state. */
export function freshLocalD1(root, dir) {
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "wrangler.json");
  writeFileSync(config, JSON.stringify({
    name: "sahra-restore-drill",
    main: join(root, "src", "index.ts"),
    compatibility_date: "2026-08-01",
    d1_databases: Object.entries(LOCAL_IDS).map(([binding, id]) => ({
      binding, database_name: `drill-${binding.toLowerCase()}`, database_id: id, migrations_dir: join(root, MIGRATIONS[binding]),
    })),
  }, null, 2));
  const persistTo = join(dir, "state");
  for (const binding of Object.keys(LOCAL_IDS)) {
    npx(root, ["wrangler", "d1", "migrations", "apply", binding, "--local", "--persist-to", persistTo, "-c", config]);
  }
  return { config, persistTo };
}

/** Miniflare over the same persisted files: real D1 bindings for DB, LEDGER and FILES. */
export async function openLocalD1(root, persistTo) {
  const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(join(root, "node_modules", "miniflare", "dist", "src", "index.js")).href);
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: "export default {}", resourcePersistencePath: join(persistTo, "v3"), d1Databases: LOCAL_IDS,
  }));
  return { mf, DB: await mf.getD1Database("DB"), LEDGER: await mf.getD1Database("LEDGER"), FILES: await mf.getD1Database("FILES") };
}

/** Bundles TypeScript modules from src/ for Node (as scripts/recover.mjs does) and imports them. */
export async function loadModules(root, dir, exportsText) {
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.mjs");
  writeFileSync(entry, exportsText.replace(/@src\//g, `${join(root, "src").replace(/\\/g, "/")}/`));
  const esbuild = join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
  execFileSync(esbuild, [entry, "--bundle", "--format=esm", "--platform=node", `--outfile=${out}`, "--log-level=error"], { shell: process.platform === "win32" });
  return import(pathToFileURL(out).href);
}
