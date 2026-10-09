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
  FILES_2: "00000000-0000-4000-8000-00000000d004",
  FILES_3: "00000000-0000-4000-8000-00000000d005",
  FILES_4: "00000000-0000-4000-8000-00000000d006",
};

const MIGRATIONS = { DB: "migrations", LEDGER: "migrations-ledger", FILES: "migrations-files", FILES_2: "migrations-files", FILES_3: "migrations-files", FILES_4: "migrations-files" };
const DEFAULT_BINDINGS = ["DB", "LEDGER", "FILES"];

export function npx(root, args, opts = {}) {
  const win = process.platform === "win32";
  return execFileSync(win ? "npx.cmd" : "npx", args, {
    cwd: root, encoding: "utf8", shell: win, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}

/** Creates <dir>/wrangler.json and applies every migration to fresh local databases in <dir>/state (only the bindings named). */
export function freshLocalD1(root, dir, bindings = DEFAULT_BINDINGS) {
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "wrangler.json");
  writeFileSync(config, JSON.stringify({
    name: "sahra-restore-drill",
    main: join(root, "src", "index.ts"),
    compatibility_date: "2026-08-01",
    d1_databases: Object.entries(LOCAL_IDS).filter(([b]) => bindings.includes(b)).map(([binding, id]) => ({
      binding, database_name: `drill-${binding.toLowerCase()}`, database_id: id, migrations_dir: join(root, MIGRATIONS[binding]),
    })),
  }, null, 2));
  const persistTo = join(dir, "state");
  for (const binding of bindings) {
    npx(root, ["wrangler", "d1", "migrations", "apply", binding, "--local", "--persist-to", persistTo, "-c", config]);
  }
  return { config, persistTo };
}

/** Miniflare over the same persisted files: real D1 bindings for the given names (default DB, LEDGER, FILES). */
export async function openLocalD1(root, persistTo, bindings = DEFAULT_BINDINGS) {
  const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(join(root, "node_modules", "miniflare", "dist", "src", "index.js")).href);
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: "export default {}", resourcePersistencePath: join(persistTo, "v3"),
    d1Databases: Object.fromEntries(bindings.map((b) => [b, LOCAL_IDS[b]])),
  }));
  const out = { mf };
  for (const b of bindings) out[b] = await mf.getD1Database(b);
  return out;
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
