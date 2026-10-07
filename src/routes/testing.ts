// STAGING ONLY (ENABLE_TEST_TICKETS = "1"; production sets "0" and these routes
// answer 404). They create approved, released test tickets and door invitations so
// live runs can reach enough samples per endpoint without the guest and admin
// features of Phase 4.

import { Hono } from "hono/tiny";
import { flushChangeLog } from "../changelog";
import { json, readJson, requireAuth, type AppEnv } from "../context";
import { TicketDb } from "../db/tickets";
import { base32, newId, newToken, randomBytes, sha256hex } from "../lib/crypto";
import { signQr } from "../qr";

export const testingRoutes = new Hono<AppEnv>();

testingRoutes.use("*", async (c, next) => {
  if (c.env.ENABLE_TEST_TICKETS !== "1") return json(c, 404, { error: "not_found" });
  await next();
});

testingRoutes.post("/tickets", requireAuth(["owner", "admin", "door"]), async (c) => {
  const b = (await readJson(c)) ?? {};
  const count = Number(b.count ?? 1);
  const people = Number(b.people ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isInteger(people) || people < 1 || people > 10) {
    return json(c, 400, { error: "invalid_request" });
  }
  const a = c.var.auth;
  const tdb = new TicketDb(c.var.db.driver);
  const now = c.var.deps.now();
  const out: { id: string; qr: string }[] = [];
  for (let i = 0; i < count; i++) {
    const id = base32(randomBytes(10), 16);
    const ok = await tdb.createTicket({ hash: a.hash, partyId: a.info.party_id }, {
      id, partyId: a.info.party_id, people, guestName: `Test guest ${id.slice(0, 4)}`, status: "approved", release: true,
      now, actor: a.info.staff_id, op: newId(),
    });
    if (!ok) return json(c, 401, { error: "not_signed_in" });
    out.push({ id, qr: await signQr(c.env as unknown as Record<string, unknown>, { partyId: a.info.party_id, ticketId: id, version: 1 }) });
  }
  await flushChangeLog(c.var.db, c.var.ledger, now, out.map((t) => t.id));
  return json(c, 200, { tickets: out });
});

/** A new door staff member and a 1-hour invitation (token returned). For join measurements. */
testingRoutes.post("/door-invite", requireAuth(["owner", "admin", "door"]), async (c) => {
  const a = c.var.auth;
  const now = c.var.deps.now();
  const token = newToken();
  const staffId = newId();
  const inviteId = newId();
  const ok = await c.var.db.createTestDoorInvite({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, {
    staffId, inviteId, name: `test-door-${staffId.slice(0, 6)}`, tokenHash: await sha256hex(token), now, expiresAt: now + 3600_000, op: newId(),
  });
  if (!ok) return json(c, 401, { error: "not_signed_in" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, { token, invite_id: inviteId });
});
