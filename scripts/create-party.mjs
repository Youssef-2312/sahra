#!/usr/bin/env node
// Creates a party and its first owner invitation. Run by the platform operator on
// their own computer, with their own Cloudflare login (npx wrangler login). There is
// deliberately no web endpoint for this.
//
//   node scripts/create-party.mjs --id spring27 --name "Spring 27" --capacity 300 \
//     --max-per-ticket 4 --owner-name "Youssef" --owner-email someone@gmail.com [--env staging] [--dry-run]
//
// The owner then signs in with Google at the site; the first sign-in links the
// account and records these rows in the change log.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
    return acc;
  }, []),
);

function fail(m) {
  console.error(m);
  process.exit(1);
}
function normalizeEmail(email) {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return null;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.split("+")[0].replace(/\./g, "");
  return `${local}@${domain}`;
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const id = args.id ?? "";
if (!/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(id)) fail("--id: 3-24 chars, lowercase letters, digits, dashes");
const name = (args.name ?? "").trim();
if (!name || name.length > 80) fail("--name required (max 80 chars)");
const capacity = Number(args.capacity);
if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) fail("--capacity: whole number");
const maxPer = Number(args["max-per-ticket"] ?? 1);
if (!Number.isInteger(maxPer) || maxPer < 1 || maxPer > 50) fail("--max-per-ticket: 1-50");
const ownerName = (args["owner-name"] ?? "").trim();
if (!ownerName || ownerName.length > 80) fail("--owner-name required");
const email = normalizeEmail(args["owner-email"] ?? "");
if (!email) fail("--owner-email required");

const now = Date.now();
const staffId = randomUUID();
const inviteId = randomUUID();
const expires = now + 14 * 24 * 3600_000;
const sql = [
  `INSERT INTO parties (id, name, capacity, max_people_per_ticket, created_at, last_action) VALUES (${q(id)}, ${q(name)}, ${capacity}, ${maxPer}, ${now}, 'party_created')`,
  `INSERT INTO staff (id, party_id, name, role, invited_email, created_at, created_by, last_action) VALUES (${q(staffId)}, ${q(id)}, ${q(ownerName)}, 'owner', ${q(email)}, ${now}, 'operator', 'staff_added')`,
  `INSERT INTO invites (id, kind, party_id, staff_id, role, created_by, created_at, expires_at, last_action) VALUES (${q(inviteId)}, 'google', ${q(id)}, ${q(staffId)}, 'owner', 'operator', ${now}, ${expires}, 'invite_created')`,
  `INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail) VALUES (${q(id)}, ${now}, NULL, 'party_created', 'party', ${q(id)}, 1, 'operator script'), (${q(id)}, ${now}, NULL, 'staff_added', 'staff', ${q(staffId)}, 1, 'operator script'), (${q(id)}, ${now}, NULL, 'invite_created', 'invite', ${q(inviteId)}, 1, 'operator script')`,
].join(";\n") + ";";


if (args.env && args.env !== "prod" && args.env !== "staging") fail("--env must be prod or staging");
console.log(sql);
if (args["dry-run"] === "true") process.exit(0);

// The SQL goes in a temporary file (not on the command line), so quoting works the
// same on Windows and elsewhere. One INSERT batch: it either all applies or none.
const dir = mkdtempSync(join(tmpdir(), "sahra-"));
const file = join(dir, "party.sql");
writeFileSync(file, sql);
const WIN = process.platform === "win32";
const wranglerArgs = ["wrangler", "d1", "execute", "DB", "--remote", "--file", file, ...(args.env === "staging" ? ["--env", "staging"] : [])];
let ok = false;
for (const wait of [0, 2, 4, 8, 16]) {
  if (wait) { console.log(`Retrying in ${wait} s...`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait * 1000); }
  const r = WIN
    ? spawnSync(["npx.cmd", ...wranglerArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" "), { shell: true, stdio: "pipe", encoding: "utf8" })
    : spawnSync("npx", wranglerArgs, { stdio: "pipe", encoding: "utf8" });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (r.status === 0) { ok = true; break; }
  // A duplicate id or other SQL error will not improve by retrying.
  if (/UNIQUE constraint|SQLITE_|not logged in|Authentication error/i.test(`${r.stdout}${r.stderr}`)) break;
}
rmSync(dir, { recursive: true, force: true });
if (!ok) fail("Creating the party failed (see above). A UNIQUE constraint error after a retry can mean the first attempt did succeed: check with setup.bat (create party checks first) before trying again.");
console.log(`\nParty "${id}" created. Owner ${email} can now sign in with Google (invitation valid 14 days).`);
