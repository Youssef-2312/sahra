// Party owner/admin ticket management: the approval queue (with screenshots),
// approve / reject / release in bulk, cancel, reissue, name transfer, the
// sign-up form, and the guest list export. Every change is checked inside its SQL
// (session, party, ticket state, capacity) and confirmed only after the change log
// is written (flushChangeLog; otherwise 503 "pending", and a retry finishes it).
//
// Approval and release are separate steps: approving never sends anything. Only
// release ("Send QR") adds the guest's email to the outbox, in the same batch.
//
// Cancel, reissue and name transfer would be unsafe to lose in a recovery (an old
// QR could come back), so their intent goes to the ledger first (src/changes.ts),
// under the op id the browser sends; a retry with the same op id is recognized.

import { Hono } from "hono/tiny";
import { flushChangeLog } from "../changelog";
import { recordIntent } from "../changes";
import { json, readJson, requireAuth, type AppEnv, type Ctx } from "../context";
import { D1Driver } from "../db/driver";
import { TicketDb } from "../db/tickets";
import { GuestDb, MAX_BULK } from "../guests/db";
import { emailTemplates, linkEmail, releasedEmail } from "../guests/emails";
import { parseForm, storedForm } from "../guests/form";
import { linkPath, signLink } from "../guests/link";
import { isBase32, isUuid, newId } from "../lib/crypto";
import { chargeStaff } from "../limits";
import type { OutboxRow } from "../outbox";
import { getScreenshot } from "../storage";
import { guestEmail } from "./guests";

export const ticketRoutes = new Hono<AppEnv>();

const MANAGERS = ["owner", "admin"] as const;
const STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);

function envRecord(c: Ctx): Record<string, unknown> {
  return c.env as unknown as Record<string, unknown>;
}

function isTicketId(v: unknown): v is string {
  return typeof v === "string" && isBase32(v, 16);
}

function ticketIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_BULK || !v.every(isTicketId)) return null;
  return new Set(v).size === v.length ? (v as string[]) : null;
}

function sessOf(c: Ctx) {
  const a = c.var.auth;
  return { sess: { hash: a.hash, partyId: a.info.party_id }, actor: a.info.staff_id, now: c.var.deps.now() };
}

function intParam(v: string | undefined, dflt: number, max: number): number | null {
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** Tickets with one status (default: the approval queue), oldest first. Cursor: `after=<created_at>.<id>`. */
ticketRoutes.get("/", requireAuth(MANAGERS), async (c) => {
  const status = c.req.query("status") ?? "pending";
  const limit = intParam(c.req.query("limit"), 50, 100);
  const after = c.req.query("after");
  const m = after === undefined ? null : /^([0-9]{1,15})\.([0-9A-Z]{16})$/.exec(after);
  if (!STATUSES.has(status) || !limit || (after !== undefined && !m)) return json(c, 400, { error: "invalid_request" });
  const { sess, now } = sessOf(c);
  const rows = await new GuestDb(c.var.db.driver).list(sess, status, m ? { at: Number(m[1]), id: m[2]! } : null, limit, now);
  const last = rows.at(-1);
  return json(c, 200, {
    tickets: rows.map((r) => ({ ...r, answers: r.answers ? JSON.parse(String(r.answers)) : {}, has_screenshot: !!r.has_screenshot })),
    next: rows.length === limit && last ? `${last.created_at}.${last.id}` : null,
  });
});

ticketRoutes.get("/form", requireAuth(MANAGERS), async (c) => {
  const { sess, now } = sessOf(c);
  const r = await new GuestDb(c.var.db.driver).getForm(sess, now);
  if (!r) return json(c, 401, { error: "not_signed_in" });
  return json(c, 200, { form: storedForm(r.guest_form), capacity: r.capacity, max_people_per_ticket: r.max_people_per_ticket, held: r.held });
});

/** The party's sign-up questions and screenshot rule. */
ticketRoutes.post("/form", requireAuth(MANAGERS), async (c) => {
  const form = parseForm((await readJson(c))?.form);
  if (!form) return json(c, 400, { error: "invalid_form" });
  const { sess, actor, now } = sessOf(c);
  if (!(await new GuestDb(c.var.db.driver).setForm(sess, JSON.stringify(form), now, actor, newId()))) return json(c, 409, { error: "not_allowed" });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, { form });
});

/** Guest list export, paged by ticket id (`after`); the browser builds the CSV. */
ticketRoutes.get("/export", requireAuth(MANAGERS), async (c) => {
  const limit = intParam(c.req.query("limit"), 200, 500);
  const after = c.req.query("after") ?? "";
  if (!limit || (after !== "" && !isTicketId(after))) return json(c, 400, { error: "invalid_request" });
  const over = await chargeStaff(c, "export", 1, MANAGERS);
  if (over) return over;
  const { sess, now } = sessOf(c);
  const rows = await new GuestDb(c.var.db.driver).exportPage(sess, after, limit, now);
  return json(c, 200, {
    tickets: rows.map((r) => ({ ...r, answers: r.answers ? JSON.parse(String(r.answers)) : {} })),
    next: rows.length === limit ? String(rows.at(-1)!.id) : null,
  });
});

/** The payment screenshot of one of this party's tickets. Owner/admin only, never cached. */
ticketRoutes.get("/:id/screenshot", requireAuth(MANAGERS), async (c) => {
  const id = c.req.param("id");
  if (!isTicketId(id)) return json(c, 404, { error: "not_found" });
  const { sess, now } = sessOf(c);
  const key = await new GuestDb(c.var.db.driver).screenshotKey(sess, id, now);
  if (!key) return json(c, 404, { error: "not_found" });
  const f = await getScreenshot(c.env, key, sess.partyId, id);
  if (f === "not_configured") return json(c, 503, { error: "uploads_not_configured" });
  if (!f) return json(c, 404, { error: "not_found" });
  if ("deleted" in f) return json(c, 410, { error: "screenshot_deleted", message: f.deleted });
  return new Response(f.bytes, {
    headers: { "content-type": f.type, "cache-control": "no-store, private", "content-disposition": "inline" },
  });
});

ticketRoutes.post("/approve", requireAuth(MANAGERS), async (c) => {
  const ids = ticketIds((await readJson(c))?.ids);
  if (!ids) return json(c, 400, { error: "invalid_request", max: MAX_BULK });
  const { sess, actor, now } = sessOf(c);
  const results = await new GuestDb(c.var.db.driver).approve(sess, ids, now, actor, newId());
  await flushChangeLog(c.var.db, c.var.ledger, now, ids);
  return json(c, 200, { results });
});

ticketRoutes.post("/reject", requireAuth(MANAGERS), async (c) => {
  const b = await readJson(c);
  const ids = ticketIds(b?.ids);
  const reason = b?.reason === undefined || b?.reason === null ? null : typeof b.reason === "string" ? b.reason.trim().slice(0, 300) || null : undefined;
  if (!ids || reason === undefined) return json(c, 400, { error: "invalid_request", max: MAX_BULK });
  const { sess, actor, now } = sessOf(c);
  const results = await new GuestDb(c.var.db.driver).reject(sess, ids, reason, now, actor, newId());
  await flushChangeLog(c.var.db, c.var.ledger, now, ids);
  return json(c, 200, { results });
});

/**
 * "Reject every pending request older than N hours" (owner decision: pending
 * requests are only cleaned up by hand). One bounded batch per call; the page
 * repeats the call while `remaining` > 0. The reason is shown to the guests.
 */
ticketRoutes.post("/reject-stale", requireAuth(MANAGERS), async (c) => {
  const b = await readJson(c);
  const hours = b?.hours;
  const reason = typeof b?.reason === "string" ? b.reason.trim().slice(0, 300) : "";
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 720 || !reason) {
    return json(c, 400, { error: "invalid_request", hours: "1..720", reason: "required" });
  }
  const over = await chargeStaff(c, "reject_stale", 1, MANAGERS);
  if (over) return over;
  const { sess, actor, now } = sessOf(c);
  const r = await new GuestDb(c.var.db.driver).rejectStale(sess, now - hours * 3600_000, reason, MAX_BULK, now, actor, newId());
  await flushChangeLog(c.var.db, c.var.ledger, now, r.ids);
  return json(c, 200, { rejected: r.ids.length, remaining: r.remaining });
});

/** "Send QR" for one or many approved tickets: release + their emails in one batch. */
ticketRoutes.post("/release", requireAuth(MANAGERS), async (c) => {
  const ids = ticketIds((await readJson(c))?.ids);
  if (!ids) return json(c, 400, { error: "invalid_request", max: MAX_BULK });
  const over = await chargeStaff(c, "release", ids.length, MANAGERS);
  if (over) return over;
  const { sess, actor, now } = sessOf(c);
  const gdb = new GuestDb(c.var.db.driver);
  const env = envRecord(c);
  const emails: OutboxRow[] = [];
  const templates = await emailTemplates(c.var.db.driver, sess.partyId);
  for (const t of await gdb.releasable(sess, ids, now)) {
    if (!t.guest_email) continue;
    const link = await signLink(env, { partyId: sess.partyId, ticketId: t.id, version: t.link_version });
    emails.push(releasedEmail({
      origin: c.env.PUBLIC_ORIGIN, partyId: sess.partyId, partyName: t.party_name, ticketId: t.id, to: t.guest_email,
      guestName: t.guest_name, people: t.people, link, now, actor, templates,
    }));
  }
  const results = await gdb.release(sess, ids, emails, now, actor, newId());
  await flushChangeLog(c.var.db, c.var.ledger, now, ids);
  return json(c, 200, { results });
});

/**
 * Cancel or reissue: intent first, then the change (TicketDb), then the change log.
 * `op` (a UUID from the browser) makes a retry after "pending" recognizable.
 */
async function intentChange(c: Ctx, action: "cancelled" | "reissued") {
  const id = c.req.param("id");
  const op = (await readJson(c))?.op;
  if (!isTicketId(id) || !isUuid(op)) return json(c, 400, { error: "invalid_request" });
  const { sess, actor, now } = sessOf(c);
  const tdb = new TicketDb(c.var.db.driver);
  const before = await tdb.getTicket(sess.partyId, id);
  if (!before) return json(c, 404, { error: "not_found" });
  let status: "done" | "already";
  if (before.last_op === op && before.last_action === action) {
    status = "already";
  } else {
    await recordIntent(c.var.ledger, op, sess.partyId, action, [{ entity: "ticket", id }], now);
    const ok = action === "cancelled" ? await tdb.cancel(sess, id, now, actor, op) : await tdb.reissue(sess, id, now, actor, op);
    if (!ok) return json(c, 409, { error: "not_allowed" });
    status = "done";
  }
  await flushChangeLog(c.var.db, c.var.ledger, now, [id]);
  return json(c, 200, { status });
}

ticketRoutes.post("/:id/cancel", requireAuth(MANAGERS), (c) => intentChange(c, "cancelled"));
ticketRoutes.post("/:id/reissue", requireAuth(MANAGERS), (c) => intentChange(c, "reissued"));

/**
 * Name transfer (feature 13): new name (and optionally a new email); the ticket is
 * reissued in the same statement, so the old QR and the old link stop working.
 * The new link is emailed (outbox) and returned to the owner/admin.
 */
ticketRoutes.post("/:id/transfer", requireAuth(MANAGERS), async (c) => {
  const id = c.req.param("id");
  const b = await readJson(c);
  const name = typeof b?.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  const email = b?.email === undefined || b?.email === null || b?.email === "" ? null : guestEmail(b.email);
  if (!isTicketId(id) || !isUuid(b?.op) || name.length < 1 || name.length > 80 || (b?.email && !email)) {
    return json(c, 400, { error: "invalid_request" });
  }
  const op = b.op;
  const { sess, actor, now } = sessOf(c);
  const gdb = new GuestDb(c.var.db.driver);
  const t = await gdb.ticket(sess, id, now);
  if (!t) return json(c, 404, { error: "not_found" });
  const env = envRecord(c);
  let version = t.link_version;
  let status: "done" | "already";
  if (t.last_op === op && t.last_action === "name_transferred") {
    status = "already";
  } else {
    version = t.link_version + 1;
    const link = await signLink(env, { partyId: sess.partyId, ticketId: id, version });
    const to = email ?? t.guest_email;
    const mail = to ? linkEmail({ id: newId(), origin: c.env.PUBLIC_ORIGIN, partyId: sess.partyId, partyName: t.party_name, to,
      links: [link], ticketId: id, now, createdBy: actor, templates: await emailTemplates(c.var.db.driver, sess.partyId) }) : null;
    await recordIntent(c.var.ledger, op, sess.partyId, "name_transferred", [{ entity: "ticket", id }], now);
    if (!(await gdb.transfer(sess, { id, name, email, fromLinkVersion: t.link_version, linkEmail: mail }, now, actor, op))) {
      return json(c, 409, { error: "not_allowed" });
    }
    status = "done";
  }
  await flushChangeLog(c.var.db, c.var.ledger, now, [id]);
  return json(c, 200, { status, link: linkPath(await signLink(env, { partyId: sess.partyId, ticketId: id, version })) });
});
