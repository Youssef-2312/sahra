// Opening and pausing admission (owner or admin). The control object in the
// ledger is the authority scanners read first; the main database keeps a copy of
// state + pause_number that the redemption statement also requires.
//
// Pause: control object first (paused, pause_number + 1), then the main database.
//   Scanners stop as soon as the control object changes.
// Open: main database first (open, pause_number copied from the control object),
//   then the control object. Until both agree, scans answer "paused".

import { Hono } from "hono/tiny";
import { flushChangeLog } from "../changelog";
import { json, readJson, requireAuth, type AppEnv } from "../context";
import { TicketDb } from "../db/tickets";
import { newId } from "../lib/crypto";
import { PartyDb } from "../party/db";
import type { Ctx } from "../context";

export const admissionRoutes = new Hono<AppEnv>();

admissionRoutes.get("/", requireAuth(["owner", "admin", "door"]), async (c) => {
  const p = c.var.auth.info.party_id;
  const [control, db] = await Promise.all([c.var.ledger.getControl(p), new TicketDb(c.var.db.driver).partyAdmission(p)]);
  return json(c, 200, { control, database: db, open: !!control && control.state === "open" && db?.admission_state === "open" && db.pause_number === control.pause_number });
});

admissionRoutes.post("/", requireAuth(["owner", "admin"]), async (c) => {
  const b = await readJson(c);
  const action = b?.action;
  if (action !== "open" && action !== "pause") return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const sess = { hash: a.hash, partyId: a.info.party_id };
  const now = c.var.deps.now();
  const tdb = new TicketDb(c.var.db.driver);
  const control = await c.var.ledger.getControl(sess.partyId);
  const party = await tdb.partyAdmission(sess.partyId);
  if (!party) return json(c, 404, { error: "not_found" });

  if (action === "pause") {
    const pn = await pauseAdmission(c, sess, a.info.staff_id, now);
    if (pn === null) return json(c, 409, { error: "changed_meanwhile_try_again" });
    await flushChangeLog(c.var.db, c.var.ledger, now);
    return json(c, 200, { state: "paused", pause_number: pn });
  }
  // A cancelled party never opens again (migrations/0026).
  if ((await new PartyDb(c.var.db.driver).get(sess.partyId))?.cancelled_at) return json(c, 409, { error: "party_cancelled" });

  const pn = control?.pause_number ?? party.pause_number;
  if (!(await tdb.setAdmission(sess, "open", pn, now, a.info.staff_id, newId()))) return json(c, 409, { error: "not_allowed" });
  if (!(await c.var.ledger.setControl(sess.partyId, control?.rev ?? 0, { state: "open", pause_number: pn }, now, a.info.staff_id))) {
    return json(c, 409, { error: "changed_meanwhile_try_again" });
  }
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, { state: "open", pause_number: pn });
});

/**
 * Pause: the control object first (paused, pause_number + 1; scanners stop at
 * once), then the main database. Shared with cancelling a party. Returns the new
 * pause_number, or null when the control object changed meanwhile.
 */
export async function pauseAdmission(c: Ctx, sess: { hash: string; partyId: string }, staffId: string, now: number): Promise<number | null> {
  const tdb = new TicketDb(c.var.db.driver);
  const control = await c.var.ledger.getControl(sess.partyId);
  const party = await tdb.partyAdmission(sess.partyId);
  const pn = Math.max(control?.pause_number ?? 0, party?.pause_number ?? 0) + 1;
  if (!(await c.var.ledger.setControl(sess.partyId, control?.rev ?? 0, { state: "paused", pause_number: pn }, now, staffId))) return null;
  await tdb.setAdmission(sess, "paused", pn, now, staffId, newId());
  return pn;
}
