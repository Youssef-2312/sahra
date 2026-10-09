#!/usr/bin/env node
// Browser check of the door scanner with a camera, end to end, on a LOCAL server
// only. It creates its own door invitation and a fresh released ticket at the
// party of the given owner session, opens admission, turns that ticket's real QR
// (from its ticket page) into fake camera video, joins as door staff and scans:
// the first read must be green (admitted), the same code read again must be red
// (already used). Nothing leaves this computer and no email is sent (the ticket
// has no email address).
//
//   SAHRA_TEST_ORIGIN=http://127.0.0.1:8799 SAHRA_OWNER_SESSION=<owner session token> \
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/scan-browser.mjs
//
// Needs ffmpeg on PATH (the QR image becomes a short .y4m video for Chromium's fake camera).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.SAHRA_TEST_ORIGIN || "http://127.0.0.1:8799";
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname), "Use a local development server only");
const session = process.env.SAHRA_OWNER_SESSION;
assert.ok(session, "Set SAHRA_OWNER_SESSION to an owner session token of a local party");

const dir = mkdtempSync(join(tmpdir(), "sahra-scan-"));
const cookie = { "__Host-sahra_s": session };
async function call(method, path, body, csrf) {
  const headers = { cookie: Object.entries(cookie).map(([k, v]) => `${k}=${v}`).join("; "), origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (csrf) headers["x-sahra-csrf"] = csrf;
  const r = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let browser;
try {
  const me = await call("GET", "/api/me");
  assert.equal(me.status, 200, "owner session not valid");
  assert.equal(me.body.staff.role, "owner", "the session must be an owner's");
  const csrf = me.body.csrf;

  // Admission open, a door invitation and a fresh released ticket (no email address: nothing is sent).
  const open = await call("POST", "/api/admission", { action: "open" }, csrf);
  assert.ok(open.status === 200, `opening admission failed: ${open.status} ${JSON.stringify(open.body)}`);
  const token = randomBytes(32).toString("base64url");
  const inv = await call("POST", "/api/staff/door-invite", { staff_id: randomUUID(), invite_id: randomUUID(), name: "Scan check", token, hours: 1 }, csrf);
  assert.ok(inv.status === 200 || inv.status === 201, `door invitation failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const issued = await call("POST", "/api/tickets/issue", { op: randomUUID(), name: "Scan Check Guest", people: 1, complimentary: true, release: true }, csrf);
  assert.ok(issued.status === 201, `issuing a ticket failed: ${issued.status} ${JSON.stringify(issued.body)}`);
  const link = /#t=(.+)$/.exec(issued.body.link)[1];

  browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${join(dir, "qr.y4m")}`] });

  // The ticket's own QR image, as the guest sees it, made into 8 s of camera video.
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await guest.goto(`${origin}/ticket#t=${link}`, { waitUntil: "networkidle" });
  const src = await guest.locator(".qr-box img").getAttribute("src");
  assert.ok(src && src.startsWith("data:image/"), "the ticket page shows no QR");
  writeFileSync(join(dir, "qr.png"), Buffer.from(src.split(",")[1], "base64"));
  await guest.close();
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-loop", "1", "-i", join(dir, "qr.png"),
    "-vf", "scale=360:360:flags=neighbor,pad=640:480:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p", "-t", "8", "-r", "10", "-f", "yuv4mpegpipe", join(dir, "qr.y4m")]);

  // Door staff: join with the invitation, start the camera, scan.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.grantPermissions(["camera"], { origin });
  const door = await ctx.newPage();
  const errors = [], verdicts = [];
  door.on("pageerror", (e) => errors.push(e.message));
  door.on("response", async (r) => { if (new URL(r.url()).pathname === "/api/scan" && r.request().method() === "POST") verdicts.push((await r.json().catch(() => ({}))).verdict); });
  await door.goto(`${origin}/join#t=${token}`, { waitUntil: "networkidle" });
  await door.getByRole("button", { name: "Join" }).click();
  await door.waitForURL(/\/scan(\.html)?$/, { timeout: 15000 });
  await door.getByRole("button", { name: "Start camera" }).click();
  await door.waitForSelector(".verdict.full.yes", { timeout: 20000 });
  console.log("PASS first read of a fresh ticket: green (admitted)");
  // Green clears by itself; the same code still in view is read again: already used, red.
  await door.waitForSelector(".verdict.full.no", { timeout: 25000 });
  console.log("PASS same ticket read again: red");
  assert.deepEqual(errors, [], "page errors on the scanner");
  assert.equal(verdicts[0], "admit", `first verdict was ${verdicts[0]}`);
  assert.ok(verdicts.slice(1).length > 0 && verdicts.slice(1).every((v) => v === "used"), `a later read was not "used": ${verdicts.join(", ")}`);
  console.log(`PASS verdicts in order: ${verdicts.join(", ")} (admitted exactly once)`);
} finally {
  if (browser) await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
