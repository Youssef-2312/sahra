// STAGING ONLY (ENABLE_TEST_TICKETS = "1"; production sets "0" and these routes
// answer 404). They create approved, released test tickets and door invitations so
// live runs can reach enough samples per endpoint without the guest and admin
// features of Phase 4.

import { Hono } from "hono/tiny";
import { LogPendingError, flushChangeLog } from "../changelog";
import { json, readJson, requireAuth, type AppEnv } from "../context";
import { sql } from "../db/sql";
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
  const list = Array.from({ length: count }, () => {
    const id = base32(randomBytes(10), 16);
    return { id, guestName: `Test guest ${id.slice(0, 4)}` };
  });
  if (!(await tdb.createTestTickets({ hash: a.hash, partyId: a.info.party_id }, a.info.party_id, list, people, now, a.info.staff_id, newId()))) {
    return json(c, 401, { error: "not_signed_in" });
  }
  const out: { id: string; qr: string }[] = [];
  for (const t of list) out.push({ id: t.id, qr: await signQr(c.env as unknown as Record<string, unknown>, { partyId: a.info.party_id, ticketId: t.id, version: 1 }) });
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

/**
 * Read-only (replaces setup.bat step 11 for cloud runs): every admission in the
 * main database (scan rows "admitted": ticket id + rev at admission) must have its
 * ledger record (change_log "ticket:<id>:<rev>", action "admitted"), and no
 * record may lack its admission. For the session's own party only.
 */
testingRoutes.get("/ledger-check", requireAuth(["owner", "admin", "door"]), async (c) => {
  const p = c.var.auth.info.party_id;
  const main = c.var.db.driver;
  const [admitted, outcomes, used, records] = await Promise.all([
    main.all<{ ticket_id: string; ticket_rev: number }>(sql`SELECT ticket_id, ticket_rev FROM scans WHERE party_id = ${p} AND outcome = 'admitted'`),
    main.all<{ outcome: string; n: number }>(sql`SELECT outcome, COUNT(*) AS n FROM scans WHERE party_id = ${p} GROUP BY outcome`),
    main.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tickets WHERE party_id = ${p} AND used_scan_id IS NOT NULL`),
    c.var.ledgerDriver.all<{ entity_id: string; rev: number }>(
      sql`SELECT entity_id, rev FROM change_log WHERE party_id = ${p} AND entity = 'ticket' AND action = 'admitted'`),
  ]);
  const recordKeys = new Set(records.results.map((r) => `${r.entity_id}:${r.rev}`));
  const admittedKeys = new Set(admitted.results.map((a) => `${a.ticket_id}:${a.ticket_rev}`));
  const missing = admitted.results.filter((a) => !recordKeys.has(`${a.ticket_id}:${a.ticket_rev}`));
  const orphan = records.results.filter((r) => !admittedKeys.has(`${r.entity_id}:${r.rev}`));
  return json(c, 200, {
    party: p,
    outcomes: Object.fromEntries(outcomes.results.map((o) => [o.outcome, o.n])),
    tickets_used: used.results[0]?.n ?? 0,
    admissions: admitted.results.length,
    ledger_records: records.results.length,
    missing: missing.length,
    orphan: orphan.length,
    examples: { missing: missing.slice(0, 10), orphan: orphan.slice(0, 10) },
    ok: missing.length === 0 && orphan.length === 0 && admitted.results.length === records.results.length,
  });
});

/**
 * Cleanup after a live run (replaces setup.bat step 13 for cloud runs): revokes
 * every door invitation of the session's party and ends every door session,
 * writes the change log for every revoked invitation (also any earlier one not
 * yet recorded), and ends the caller's own session last.
 */
testingRoutes.post("/revoke-door-access", requireAuth(["owner", "admin", "door"]), async (c) => {
  const a = c.var.auth;
  const sess = { hash: a.hash, partyId: a.info.party_id };
  const now = c.var.deps.now();
  const revoked = await c.var.db.revokeAllDoorAccess(sess, a.info.staff_id, now, newId());
  // 20 change-log rows per round, 3 queries per round. At most 3 rounds per request
  // (one live run measured 10 ms CPU for 63 rows in one request); the client
  // repeats the call while it answers "pending".
  let logged = 0;
  let done = false;
  for (let round = 0; round < 3 && !done; round++) {
    try {
      logged += await flushChangeLog(c.var.db, c.var.ledger, now);
      done = true;
    } catch (e) {
      if (!(e instanceof LogPendingError && e.cause === "backlog")) throw e;
      logged += 20;
    }
  }
  if (!done) return json(c, 503, { status: "pending", error: "not_recorded_yet", retry: true, revoked, logged });
  const own = a.info.kind === "door" ? await c.var.db.revokeOwnDoorSession(sess, now) : 0;
  return json(c, 200, { status: "done", invites_revoked: revoked.invites, sessions_ended: revoked.sessions + own, change_log_written: logged });
});
