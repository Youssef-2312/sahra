import { parseDateRange } from "../lib/date-range";
// The party's email outbox (owner or admin; door staff get 403): list, approve
// rows awaiting approval ("message all guests"), cancel unsent rows, or send approved due rows immediately.

import { Hono } from "hono/tiny";
import { json, readJson, requireAuth, type AppEnv, type Ctx } from "../context";
import { OUTBOX_BULK_MAX, OutboxAdmin, type Cursor, type Selection } from "../email/admin";
import { isBase32, isUuid } from "../lib/crypto";
import { chargeStaff } from "../limits";
import { scheduledSend } from "../email/sender";
import { cfConnect } from "../email/socket";
import { rateLimited } from "../lib/http";

export const outboxRoutes = new Hono<AppEnv>();

const STATUSES = new Set(["awaiting_approval", "queued", "sending", "sent", "failed", "cancelled"]);

function cursor(v: string | undefined): Cursor | null | false {
  if (!v) return null;
  const m = /^(\d{1,16})\.(.{1,128})$/.exec(v);
  return m && isOutboxId(m[2]) ? { at: Number(m[1]), id: m[2]! } : false;
}

/**
 * An outbox row id as Sahra writes them: a UUID, or a guest message or change
 * notice, "announce:<op>:<ticket>" / "notice:<op>:<ticket>" (src/party/notice.ts).
 * The statements also check the party and the status, so an id only names a row.
 */
export function isOutboxId(v: unknown): v is string {
  if (isUuid(v)) return true;
  if (typeof v !== "string") return false;
  const m = /^(?:announce|notice):([0-9a-f-]{36}):([0-9A-Z]{16})$/.exec(v);
  return !!m && isUuid(m[1]) && isBase32(m[2]!, 16);
}

function selection(b: Record<string, unknown> | null): Selection | null {
  if (!b) return null;
  if (b.all_awaiting === true && b.ids === undefined) return { allAwaiting: true };
  const ids = b.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > OUTBOX_BULK_MAX || !ids.every(isOutboxId)) return null;
  return { ids: [...new Set(ids as string[])] };
}

outboxRoutes.get("/", requireAuth(["owner", "admin"]), async (c) => {
  const status = c.req.query("status") ?? null;
  const before = cursor(c.req.query("before"));
  const range = parseDateRange(c.req.query("created_from"), c.req.query("created_before"));
  if (range === false) return json(c, 400, { error: "invalid_request" });
  if ((status !== null && !STATUSES.has(status)) || before === false) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  const r = await new OutboxAdmin(c.var.db.driver).list({ hash: a.hash, partyId: a.info.party_id }, c.var.deps.now(), status, before, range);
  return json(c, 200, r);
});

async function change(c: Ctx, which: "approve" | "cancel", s: Selection | null) {
  if (!s) return json(c, 400, { error: "invalid_request" });
  if (which === "approve") {
    const over = await chargeStaff(c, "outbox_approve", 1);
    if (over) return over;
  }
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
  return change(c, "approve", isOutboxId(id) ? { ids: [id] } : null);
});
outboxRoutes.post("/:id/cancel", requireAuth(["owner", "admin"]), async (c) => {
  const id = c.req.param("id");
  return change(c, "cancel", isOutboxId(id) ? { ids: [id] } : null);
});

// Manually run the same safe sender as the scheduled trigger. Only rows already
// approved and due are eligible; provider caps, retries and atomic claims apply.
outboxRoutes.post("/send-now", requireAuth(["owner", "admin"]), async (c) => {
  const staffId=c.var.auth.info.staff_id;
  if(await rateLimited(c.env.RL_AUTH,`outbox-send-now:${staffId}`))return json(c,429,{error:"rate_limited"});
  const report=await scheduledSend(c.env,c.var.db.driver,{now:()=>c.var.deps.now(),random:Math.random,connect:cfConnect,fetch:c.var.deps.fetch});
  return json(c,200,{status:"complete",...report});
});
