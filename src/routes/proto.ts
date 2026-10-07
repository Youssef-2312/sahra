// TEMPORARY (Checkpoint A): measures the scan path before Phase 2 builds it for real.
// Enabled only when ENABLE_PROTO = "1". Phase 2 removes this file.

import { Hono } from "hono";
import { json, readJson, requireAuth, type AppEnv } from "../context";
import { ProtoDb } from "../db/proto";
import { base32, deriveHmacKey, hmac, isBase32, isUuid, randomBytes, sha256hex, timingSafeEqualStr } from "../lib/crypto";
import { rateLimited } from "../lib/http";

export const protoRoutes = new Hono<AppEnv>();

protoRoutes.use("*", async (c, next) => {
  if (c.env.ENABLE_PROTO !== "1") return json(c, 404, { error: "not_found" });
  await next();
});

const KEY_ID = 1;

/** S1.<PARTY>.<keyid><ticket 16 base32>.<version>.<signature 26 base32 = 130 bits> */
async function sign(env: Record<string, unknown>, partyId: string, ticketId: string, version: number) {
  const body = `S1.${partyId.toUpperCase()}.${KEY_ID}${ticketId}.${version}`;
  const key = await deriveHmacKey(env, "QR", partyId, KEY_ID);
  return `${body}.${base32(await hmac(key, body), 26)}`;
}

async function verify(env: Record<string, unknown>, partyId: string, qr: string) {
  const m = /^S1\.([A-Z0-9-]{1,24})\.([1-9])([0-9A-Z]{16})\.([0-9]{1,6})\.([0-9A-Z]{26})$/.exec(qr);
  if (!m || m[1] !== partyId.toUpperCase() || !isBase32(m[3]!, 16) || !isBase32(m[5]!, 26)) return null;
  const keyId = Number(m[2]);
  const body = qr.slice(0, qr.lastIndexOf("."));
  const key = await deriveHmacKey(env, "QR", partyId, keyId);
  const expected = base32(await hmac(key, body), 26);
  if (!timingSafeEqualStr(expected, m[5]!)) return null;
  return { ticketId: m[3]!, version: Number(m[4]) };
}

protoRoutes.post("/ticket", requireAuth(["owner", "admin", "door"]), async (c) => {
  const a = c.var.auth;
  const id = base32(randomBytes(10), 16);
  const proto = new ProtoDb(c.var.db.driver);
  if (!(await proto.createTicket({ hash: a.hash, partyId: a.info.party_id }, id, c.var.deps.now()))) {
    return json(c, 401, { error: "not_signed_in" });
  }
  const ctl = `control/${a.info.party_id}.json`;
  if (!(await c.env.BUCKET.head(ctl))) {
    await c.env.BUCKET.put(ctl, JSON.stringify({ state: "open", pause_number: 0 }), { onlyIf: { etagDoesNotMatch: "*" } });
  }
  return json(c, 200, { qr: await sign(c.env as unknown as Record<string, unknown>, a.info.party_id, id, 1) });
});

protoRoutes.post("/scan", requireAuth(["owner", "admin", "door"]), async (c) => {
  const a = c.var.auth;
  if (await rateLimited(c.env.RL_SCAN, `scan:${a.hash}`)) return json(c, 429, { verdict: "cant_verify", reason: "rate_limited" });
  const b = await readJson(c);
  if (!b || !isUuid(b.scan_id) || typeof b.qr !== "string" || b.qr.length > 128) return json(c, 400, { error: "invalid_request" });
  const env = c.env as unknown as Record<string, unknown>;
  const v = await verify(env, a.info.party_id, b.qr);
  if (!v) return json(c, 200, { verdict: "stop", reason: "invalid code" });

  const ctlKey = `control/${a.info.party_id}.json`;
  const ctl1 = await c.env.BUCKET.get(ctlKey);
  if (!ctl1) return json(c, 200, { verdict: "paused" });
  const control = (await ctl1.json()) as { state: string; pause_number: number };
  if (control.state !== "open") return json(c, 200, { verdict: "paused" });

  const now = c.var.deps.now();
  const proto = new ProtoDb(c.var.db.driver);
  const fp = await sha256hex(b.qr);
  const r = await proto.redeem({
    sess: { hash: a.hash, partyId: a.info.party_id }, staffId: a.info.staff_id, scanId: b.scan_id,
    ticketId: v.ticketId, qrVersion: v.version, fingerprint: fp, pauseNumber: control.pause_number, now,
  });
  if (!r.row) return json(c, 200, { verdict: "not_signed_in" });
  if (r.row.ticket_id !== v.ticketId || r.row.qr_fingerprint !== fp || r.row.session_hash !== a.hash) {
    return json(c, 200, { verdict: "stop", reason: "scan id conflict" });
  }
  if (r.row.outcome !== "admitted") return json(c, 200, { verdict: r.row.outcome === "already_used" ? "used" : "stop", reason: r.row.outcome });

  // Green-screen rule: admission record confirmed in R2, then control object re-read.
  try {
    const put = await c.env.BUCKET.put(`proto-admissions/${a.info.party_id}/${v.ticketId}/${r.row.rev}.json`, JSON.stringify(r.row));
    if (!put) throw new Error("unconfirmed");
  } catch {
    return json(c, 200, { verdict: "recording" });
  }
  const ctl2 = await c.env.BUCKET.get(ctlKey);
  const after = ctl2 ? ((await ctl2.json()) as { state: string; pause_number: number }) : null;
  if (!after || after.state !== "open" || after.pause_number !== control.pause_number) return json(c, 200, { verdict: "paused" });
  return json(c, 200, { verdict: "admit", rows_written: r.rows_written });
});
