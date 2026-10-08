// The party's email outbox (owner or admin; door staff get 403): list, approve
// rows awaiting approval ("message all guests"), cancel unsent rows. Sending is
// the cron's job (src/email/sender.ts).

import { Hono } from "hono/tiny";
import { json, readJson, requireAuth, type AppEnv, type Ctx } from "../context";
import { OUTBOX_BULK_MAX, OutboxAdmin, type Cursor, type Selection } from "../email/admin";
import { isUuid } from "../lib/crypto";

export const outboxRoutes = new Hono<AppEnv>();

const STATUSES = new Set(["awaiting_approval", "queued", "sending", "sent", "failed", "cancelled"]);

function cursor(v: string | undefined): Cursor | null | false {
  if (!v) return null;
  const m = /^(\d{1,16})\.([0-9a-f-]{36})$/.exec(v);
  return m && isUuid(m[2]) ? { at: Number(m[1]), id: m[2]! } : false;
}

function selection(b: Record<string, unknown> | null): Selection | null {
  if (!b) return null;
  if (b.all_awaiting === true && b.ids === undefined) return { allAwaiting: true };
  const ids = b.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > OUTBOX_BULK_MAX || !ids.every(isUuid)) return null;
  return { ids: [...new Set(ids as string[])] };
}

outboxRoutes.get("/", requireAuth(["owner", "admin"]), async (c) => {
  const status = c.req.query("status") ?? null;
  const before = cursor(c.req.query("before"));
  if ((status !== null && !STATUSES.has(status)) || before === false) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const r = await new OutboxAdmin(c.var.db.driver).list({ hash: a.hash, partyId: a.info.party_id }, c.var.deps.now(), status, before);
  return json(c, 200, r);
});

async function change(c: Ctx, which: "approve" | "cancel", s: Selection | null) {
  if (!s) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const admin = new OutboxAdmin(c.var.db.driver);
  const sess = { hash: a.hash, partyId: a.info.party_id };
  const n = which === "approve"
    ? await admin.approve(sess, a.info.staff_id, s, c.var.deps.now())
    : await admin.cancel(sess, a.info.staff_id, s, c.var.deps.now());
  // Rows already approved/cancelled, sent, in flight or of another party are left alone.
  return json(c, 200, which === "approve" ? { approved: n } : { cancelled: n });
}

outboxRoutes.post("/approve", requireAuth(["owner", "admin"]), async (c) => change(c, "approve", selection(await readJson(c))));
outboxRoutes.post("/cancel", requireAuth(["owner", "admin"]), async (c) => change(c, "cancel", selection(await readJson(c))));
outboxRoutes.post("/:id/approve", requireAuth(["owner", "admin"]), async (c) => {
  const id = c.req.param("id");
  return change(c, "approve", isUuid(id) ? { ids: [id] } : null);
});
outboxRoutes.post("/:id/cancel", requireAuth(["owner", "admin"]), async (c) => {
  const id = c.req.param("id");
  return change(c, "cancel", isUuid(id) ? { ids: [id] } : null);
});
