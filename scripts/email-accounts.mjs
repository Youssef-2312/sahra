#!/usr/bin/env node
// Sets the platform's Gmail accounts (up to three) as Cloudflare secrets from a
// plain text list, in one Wrangler call. Run by the owner on their own computer:
//
//   double-click email-accounts.bat (it asks: staging or production), or
//   email-accounts.bat staging / email-accounts.bat production
//   (or node scripts/email-accounts.mjs staging); add --dry-run to only check the list
//
// The list is email-accounts.txt in the project folder (never committed: it is in
// .gitignore). One account per line: the Gmail address, a space, its 16-letter app
// password (spaces inside it are fine). Lines starting with # are ignored.
// Accounts 1, 2 and 3 are used in that order (src/email/sender.ts). Slots not in
// the list are cleared, so removing a line removes that account.
//
// Passwords are never printed. They go to Wrangler in a temporary file readable
// only by you, deleted right after.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const SLOTS = [["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"], ["GMAIL_ADDRESS_2", "GMAIL_APP_PASSWORD_2"], ["GMAIL_ADDRESS_3", "GMAIL_APP_PASSWORD_3"]];
const LIST = "email-accounts.txt";

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

/** Lines of the list -> [{ address, password }], or an error naming the line. Exported for the test. */
export function parseList(text) {
  const out = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const [address, ...rest] = line.split(/\s+/);
    const password = rest.join("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { error: `Line ${i + 1}: "${address}" is not an email address.` };
    if (!/^[a-zA-Z]{16}$/.test(password)) return { error: `Line ${i + 1} (${address}): the app password must be the 16 letters Google showed you.` };
    if (out.some((a) => a.address.toLowerCase() === address.toLowerCase())) return { error: `Line ${i + 1}: ${address} is in the list twice.` };
    out.push({ address, password });
  }
  if (out.length === 0) return { error: `${LIST} has no accounts. Add one line per account: address, a space, app password.` };
  if (out.length > SLOTS.length) return { error: `${LIST} has ${out.length} accounts; Sahra uses up to ${SLOTS.length}.` };
  return { accounts: out };
}

/** The secrets to send: every slot, unused ones null (deleted). Exported for the test. */
export function secretsFor(accounts) {
  const s = {};
  SLOTS.forEach(([a, p], i) => {
    s[a] = accounts[i] ? accounts[i].address : null;
    s[p] = accounts[i] ? accounts[i].password : null;
  });
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  let target = args.find((a) => a === "staging" || a === "production");
  const dry = args.includes("--dry-run");
  if (!target) {
    // Double-clicked: ask.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const w = (await rl.question("Set the email accounts for staging or production? Type staging or production: ")).trim().toLowerCase();
    rl.close();
    if (w !== "staging" && w !== "production") fail("Nothing was changed.");
    target = w;
  }

  let text;
  try { text = readFileSync(LIST, "utf8"); }
  catch { fail(`${LIST} not found in this folder. Copy email-accounts.example.txt to ${LIST} and fill it in.`); }
  const r = parseList(text);
  if (r.error) fail(r.error);

  console.log(`\nSahra email accounts for ${target.toUpperCase()}:`);
  r.accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.address}`));
  for (let i = r.accounts.length; i < SLOTS.length; i++) console.log(`  ${i + 1}. (none, cleared)`);
  console.log(`About ${r.accounts.length * 450} emails per day from Gmail. Passwords are not shown.`);
  if (dry) { console.log("\nDry run: nothing was changed.\n"); return; }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\nType ${target === "production" ? "production" : "yes"} to set these: `)).trim().toLowerCase();
  rl.close();
  if (answer !== (target === "production" ? "production" : "yes")) fail("Nothing was changed.");

  const dir = mkdtempSync(join(tmpdir(), "sahra-"));
  const file = join(dir, "secrets.json");
  let status = 1;
  try {
    writeFileSync(file, JSON.stringify(secretsFor(r.accounts)), { mode: 0o600 });
    const wargs = ["wrangler", "secret", "bulk", file, ...(target === "staging" ? ["--env", "staging"] : [])];
    status = spawnSync("npx", wargs, { stdio: "inherit", shell: process.platform === "win32" }).status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (status !== 0) fail("Wrangler did not finish. Nothing may have changed; check the message above and run it again.");
  console.log(`\nDone. Sahra on ${target} now sends from ${r.accounts.length} Gmail account(s).\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("email-accounts.mjs")) await main();
