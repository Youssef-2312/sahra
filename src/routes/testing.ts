// STAGING ONLY (ENABLE_TEST_TICKETS = "1"; production sets "0" and these routes
// answer 404). They create approved, released test tickets and door invitations so
// live runs can reach enough samples per endpoint without the guest and admin
// features of Phase 4.

import { Hono } from "hono/tiny";
import { LogPendingError, flushChangeLog } from "../changelog";
import { json, readJson, requireAuth, type AppEnv } from "../context";
import { audit, sessionValid } from "../db";
import { sql } from "../db/sql";
import { TicketDb } from "../db/tickets";
import { base32, newId, newToken, parseToken, randomBytes, sha256hex } from "../lib/crypto";
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
  // released: false gives approved tickets whose QR was not sent yet (the load test's "not released" denials).
  const released = b.released !== false;
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
  if (!(await tdb.createTestTickets({ hash: a.hash, partyId: a.info.party_id }, a.info.party_id, list, people, now, a.info.staff_id, newId(), released))) {
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
 * Load test (scripts/load-test.mjs): a new test party, an owner session for it and
 * admission opened, in one call, so the test can run 10 parties without Google
 * sign-ins. Needs any valid staff session (the door session from an invitation
 * link is enough); the party, its owner and the session are created in ONE batch
 * whose every statement requires that session. The caller chooses the new
 * session's value (like door join), so a retry with the same body returns the
 * same party. The session lasts 3 hours; the script logs it out at the end.
 */
testingRoutes.post("/party", requireAuth(["owner", "admin", "door"]), async (c) => {
  const b = (await readJson(c)) ?? {};
  const session = typeof b.session === "string" ? b.session : "";
  const name = typeof b.name === "string" && b.name.length >= 1 && b.name.length <= 60 ? b.name : "Load test party";
  if (!parseToken(session)) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const now = c.var.deps.now();
  const newHash = await sha256hex(session);
  const partyId = `lt-${(await sha256hex(`sahra-test-party|${session}`)).slice(0, 16)}`;
  const staffId = newId();
  const op = newId();
  const ok = sessionValid({ hash: a.hash, partyId: a.info.party_id }, ["owner", "admin", "door"], now);
  const rs = await c.var.db.driver.batch([
    sql`INSERT INTO parties (id, name, capacity, created_at, last_op, last_action)
      SELECT ${partyId}, ${name}, 5000, ${now}, ${op}, 'party_created'
      WHERE ${ok} AND NOT EXISTS (SELECT 1 FROM parties WHERE id = ${partyId})`,
    sql`INSERT INTO staff (id, party_id, name, role, created_at, created_by, last_op, last_action)
      SELECT ${staffId}, ${partyId}, 'test-owner', 'owner', ${now}, ${a.info.staff_id}, ${op}, 'staff_added'
      WHERE EXISTS (SELECT 1 FROM parties WHERE id = ${partyId} AND last_op = ${op})`,
    sql`INSERT INTO sessions (id_hash, kind, party_id, staff_id, role, created_at, expires_at)
      SELECT ${newHash}, 'google', ${partyId}, ${staffId}, 'owner', ${now}, ${now + 3 * 3600_000}
      WHERE EXISTS (SELECT 1 FROM staff WHERE id = ${staffId} AND last_op = ${op})`,
    audit(now, a.info.staff_id, "party_created", "party", sql`SELECT id AS party_id, id, rev FROM parties WHERE id = ${partyId} AND last_op = ${op}`,
      `test party (load test), created from party ${a.info.party_id}`),
    audit(now, a.info.staff_id, "staff_added", "staff", sql`SELECT party_id, id, rev FROM staff WHERE id = ${staffId} AND last_op = ${op}`, "test"),
    sql`SELECT party_id FROM sessions WHERE id_hash = ${newHash}`,
  ]);
  // Created now, or by an earlier try with the same session value.
  if ((rs[5]!.results[0] as { party_id: string } | undefined)?.party_id !== partyId) return json(c, 401, { error: "not_signed_in" });
  // Opening, exactly as POST /api/admission does: main database first, then the control object.
  const owner = { hash: newHash, partyId };
  const control = await c.var.ledger.getControl(partyId);
  const pn = control?.pause_number ?? 0;
  if (!(await new TicketDb(c.var.db.driver).setAdmission(owner, "open", pn, now, staffId, newId()))) return json(c, 409, { error: "not_allowed" });
  if (control?.state !== "open" && !(await c.var.ledger.setControl(partyId, control?.rev ?? 0, { state: "open", pause_number: pn }, now, staffId))
    && (await c.var.ledger.getControl(partyId))?.state !== "open") {
    // Another try with the same body opened it meanwhile: that is fine; anything else is not.
    return json(c, 409, { error: "changed_meanwhile_try_again" });
  }
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, { party_id: partyId, admission: "open" });
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
  const [admitted, outcomes, used, records, ticketLog, ticketRows] = await Promise.all([
    main.all<{ ticket_id: string; ticket_rev: number }>(sql`SELECT ticket_id, ticket_rev FROM scans WHERE party_id = ${p} AND outcome = 'admitted'`),
    main.all<{ outcome: string; n: number }>(sql`SELECT outcome, COUNT(*) AS n FROM scans WHERE party_id = ${p} GROUP BY outcome`),
    main.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tickets WHERE party_id = ${p} AND used_scan_id IS NOT NULL`),
    c.var.ledgerDriver.all<{ entity_id: string; rev: number }>(
      sql`SELECT entity_id, rev FROM change_log WHERE party_id = ${p} AND entity = 'ticket' AND action = 'admitted'`),
    c.var.ledgerDriver.all<{ entity_id: string; rev: number; used: number }>(
      sql`SELECT entity_id, rev, json_extract(state, '$.used_scan_id') IS NOT NULL AS used FROM change_log WHERE party_id = ${p} AND entity = 'ticket'`),
    main.all<{ id: string; used: number }>(sql`SELECT id, used_scan_id IS NOT NULL AS used FROM tickets WHERE party_id = ${p}`),
  ]);
  // After a controlled recovery: a ticket whose newest change-log state is "used"
  // must be used in the database too (nothing reopens).
  const newest = new Map<string, { rev: number; used: number }>();
  for (const e of ticketLog.results) {
    const cur = newest.get(e.entity_id);
    if (!cur || e.rev > cur.rev) newest.set(e.entity_id, { rev: e.rev, used: e.used });
  }
  const usedNow = new Map(ticketRows.results.map((t) => [t.id, t.used]));
  const reopened = [...newest].filter(([id, e]) => e.used === 1 && usedNow.get(id) !== 1).map(([id]) => id);
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
    reopened: reopened.length,
    examples: { missing: missing.slice(0, 10), orphan: orphan.slice(0, 10), reopened: reopened.slice(0, 10) },
    ok: missing.length === 0 && orphan.length === 0 && admitted.results.length === records.results.length,
    // Scan rows newer than a restore point are gone after a recovery (orphans are expected then); this must stay 0.
    nothing_reopened: reopened.length === 0,
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
