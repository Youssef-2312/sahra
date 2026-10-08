// After a controlled recovery (src/recovery): tickets and staff whose latest
// change could not be confirmed are on hold. The party's owner checks each one
// and releases it with a reason (audited, change-logged).

import { Hono } from "hono/tiny";
import { flushChangeLog } from "../changelog";
import { json, readJson, requireAuth, type AppEnv } from "../context";
import { TicketDb } from "../db/tickets";
import { isUuid, newId } from "../lib/crypto";
import { listHolds } from "../recovery";

export const recoveryRoutes = new Hono<AppEnv>();

const TICKET_ID = /^[0-9A-Z]{16}$/;

function reasonOf(b: Record<string, unknown> | null): string | null {
  const r = typeof b?.reason === "string" ? b.reason.trim() : "";
  return r.length >= 3 && r.length <= 500 ? r : null;
}

recoveryRoutes.get("/holds", requireAuth(["owner"]), async (c) => {
  return json(c, 200, await listHolds(c.var.db.driver, c.var.auth.info.party_id));
});

recoveryRoutes.post("/tickets/:id/release-hold", requireAuth(["owner"]), async (c) => {
  const id = c.req.param("id");
  const reason = reasonOf(await readJson(c));
  if (!TICKET_ID.test(id) || !reason) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const now = c.var.deps.now();
  const ok = await new TicketDb(c.var.db.driver).releaseHold({ hash: a.hash, partyId: a.info.party_id }, id, reason, now, a.info.staff_id, newId());
  if (!ok) return json(c, 409, { error: "not_on_hold" });
  await flushChangeLog(c.var.db, c.var.ledger, now, [id]);
  return json(c, 200, { status: "released" });
});

recoveryRoutes.post("/staff/:id/release-hold", requireAuth(["owner"]), async (c) => {
  const id = c.req.param("id");
  const reason = reasonOf(await readJson(c));
  if (!isUuid(id) || !reason) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const now = c.var.deps.now();
  const ok = await c.var.db.releaseStaffHold({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, id, reason, now, newId());
  if (!ok) return json(c, 409, { error: "not_on_hold" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, { status: "released" });
});
