// A SqlDriver (src/db/driver.ts) over `wrangler d1 execute`, for the owner's
// scripts. Reads run as --command (JSON rows); writes run as one --file (remote
// --file returns only a summary, so writes report no per-statement counts, and
// the recovery code counts with reads). Parameters are inlined as SQL literals.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIN = process.platform === "win32";
const PERMANENT = /does not exist|\[code: 10007\]|not logged in|not authenticated|Authentication error|\[code: 10000\]|Unknown argument|Couldn't find a D1 DB|no such table|no such column|SQLITE_|syntax error|UNIQUE constraint|FOREIGN KEY/i;

function quote(a) {
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

export function wranglerOnce(args, { input, interactive = false } = {}) {
  return new Promise((resolve) => {
    const cmd = WIN ? "npx.cmd" : "npx";
    const full = ["wrangler", ...args];
    const child = spawn(WIN ? [cmd, ...full.map(quote)].join(" ") : cmd, WIN ? [] : full, {
      shell: WIN,
      stdio: interactive ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let stdoutOnly = "";
    if (!interactive) {
      child.stdout.on("data", (d) => { out += d; stdoutOnly += d; });
      child.stderr.on("data", (d) => { out += d; });
      if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    }
    child.on("close", (code) => resolve({ code: code ?? 1, out, stdout: stdoutOnly }));
  });
}

/** Retries temporary errors (2, 4, 8, 16 s). Writes are idempotent, so a retry after an unknown result is safe. */
export async function wrangler(args, opts = {}) {
  const delays = [2, 4, 8, 16];
  for (let attempt = 0; ; attempt++) {
    const r = await wranglerOnce(args, opts);
    if (r.code === 0) return r;
    if (PERMANENT.test(r.out) || attempt >= delays.length) {
      const tail = r.out.split("\n").filter((l) => /error|✘|\[code/i.test(l)).slice(-3).join("\n");
      throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed${tail ? `:\n${tail}` : ""}`);
    }
    await new Promise((ok) => setTimeout(ok, delays[attempt] * 1000));
  }
}

export function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function inline(q) {
  let i = 0;
  const text = q.text.replace(/\?/g, () => {
    if (i >= q.params.length) throw new Error("more placeholders than parameters");
    return literal(q.params[i++]);
  });
  if (i !== q.params.length) throw new Error("fewer placeholders than parameters");
  return text;
}

/**
 * @param {{ binding: "DB" | "LEDGER", env: string[], local?: boolean, persistTo?: string }} o
 *   env: wrangler's environment arguments (["--env", "staging"] or ["--env="]).
 */
export function wranglerDriver(o) {
  const where = o.local ? ["--local", ...(o.persistTo ? ["--persist-to", o.persistTo] : [])] : ["--remote"];
  const usage = { rows_read: 0, rows_written: 0, queries: 0 };
  return {
    usage,
    async all(q) {
      usage.queries++;
      const r = await wrangler(["d1", "execute", o.binding, ...where, ...o.env, "--json", "--command", inline(q)]);
      const start = r.stdout.search(/^\[\s*$/m);
      if (start < 0) throw new Error("could not read the query result");
      const parsed = JSON.parse(r.stdout.slice(start));
      const results = parsed[0]?.results ?? [];
      usage.rows_read += results.length;
      return { results, meta: { changes: 0, rows_read: results.length, rows_written: 0 } };
    },
    async batch(qs) {
      if (!qs.length) return [];
      usage.queries++;
      for (const q of qs) {
        if (/^\s*(SELECT|WITH)\b/i.test(q.text)) throw new Error("the wrangler driver runs reads through all(), not batch()");
      }
      const dir = mkdtempSync(join(tmpdir(), "sahra-"));
      const file = join(dir, "q.sql");
      writeFileSync(file, qs.map((q) => `${inline(q)};`).join("\n"));
      try {
        await wrangler(["d1", "execute", o.binding, ...where, ...o.env, "--file", file, ...(o.local ? [] : ["--yes"])]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return qs.map(() => ({ results: [], meta: { changes: 0, rows_read: 0, rows_written: 0 } }));
    },
  };
}
