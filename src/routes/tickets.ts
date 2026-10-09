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
import { isTypeId, parseType, TypeDb, typeIdFor } from "../guests/types";
import { emailChangedNotice, emailTemplates, linkEmail, releasedEmail } from "../guests/emails";
import { parseForm, storedForm } from "../guests/form";
import { linkPath, signLink } from "../guests/link";
import { base32, isBase32, isUuid, newId, sha256, sha256hex } from "../lib/crypto";
import { chargeStaff } from "../limits";
import type { OutboxRow } from "../outbox";
import { PartyDb } from "../party/db";
import { getIdPhoto, getScreenshot } from "../storage";
import { guestEmail } from "./guests";

export const ticketRoutes = new Hono<AppEnv>();

const MANAGERS = ["owner", "admin"] as const;
const STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);
/** One staff "resend ticket link" email per ticket per window (deterministic outbox id, as for guests). */
const STAFF_RESEND_WINDOW_MS = 10 * 60_000;

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
    tickets: rows.map((r) => ({ ...r, answers: r.answers ? JSON.parse(String(r.answers)) : {}, has_screenshot: !!r.has_screenshot, has_id_photo: !!r.has_id_photo })),
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

// ------------------------------------------------------------ ticket types

/** The party's ticket types (archived ones last) with places held, approved and admitted. */
ticketRoutes.get("/types", requireAuth(MANAGERS), async (c) => {
  const { sess, now } = sessOf(c);
  const types = await new TypeDb(c.var.db.driver).list(sess, now);
  return json(c, 200, {
    currency: "EGP",
    types: types.map((t) => ({ ...t, staff_only: !!t.staff_only, archived: t.archived_at !== null,
      places_left: t.quantity === null ? null : Math.max(0, t.quantity - t.held) })),
  });
});

async function partyZone(c: Ctx, partyId: string) {
  return (await new PartyDb(c.var.db.driver).get(partyId))?.time_zone ?? null;
}

function typeAnswer(c: Ctx, r: Awaited<ReturnType<TypeDb["create"]>>) {
  if (r.status !== "rejected") return null;
  const code = r.reason === "not_found" ? 404 : r.reason === "sales_close_before_open" || r.reason === "people_min_above_max" ? 400 : 409;
  return json(c, code, { error: r.reason, ...(r.held !== undefined ? { held: r.held } : {}) });
}

/**
 * New ticket type. Body: name (required), price (EGP per person), quantity (places,
 * null = only the party capacity), sales_opens_at / sales_closes_at / entry_from
 * (UTC ms, or *_local in the party's zone), staff_only, payment_instructions,
 * description, sort, and `op` (a UUID: a retry after "pending" is the same type).
 */
ticketRoutes.post("/types", requireAuth(MANAGERS), async (c) => {
  const b = await readJson(c);
  if (!b || !isUuid(b.op)) return json(c, 400, { error: "invalid_request" });
  const { sess, actor, now } = sessOf(c);
  const parsed = parseType(b, await partyZone(c, sess.partyId), true);
  if (!parsed.ok) return json(c, 400, { error: parsed.error });
  const id = await typeIdFor(sess.partyId, b.op);
  const tdb = new TypeDb(c.var.db.driver);
  const r = await tdb.create(sess, id, parsed.values, now, actor, newId());
  const refused = typeAnswer(c, r);
  if (refused) return refused;
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, r.status === "created" ? 201 : 200, { status: r.status, type: await tdb.get(sess.partyId, id) });
});

/** Edit a type; `archived: true` stops new tickets of it (existing ones keep it), `false` restores it. */
ticketRoutes.post("/types/:id", requireAuth(MANAGERS), async (c) => {
  const id = c.req.param("id");
  const b = await readJson(c);
  if (!isTypeId(id) || !b) return json(c, 400, { error: "invalid_request" });
  const { sess, actor, now } = sessOf(c);
  const { op: _op, ...body } = b;
  const parsed = parseType(body, await partyZone(c, sess.partyId), false);
  if (!parsed.ok) return json(c, 400, { error: parsed.error });
  const tdb = new TypeDb(c.var.db.driver);
  const r = await tdb.update(sess, id, parsed.values, parsed.archived, now, actor, newId());
  const refused = typeAnswer(c, r);
  if (refused) return refused;
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, { status: r.status, type: await tdb.get(sess.partyId, id) });
});

// ------------------------------------------------- staff-issued tickets, search

/**
 * Issue a ticket (complimentary or the door list): approved at once; with
 * `release: true` its QR is sent too (email in the same batch when there is an
 * address). Body: op (UUID), name, email?, people?, type_id?, complimentary?, release?.
 * Same capacity and type-places rules as a guest request.
 */
ticketRoutes.post("/issue", requireAuth(MANAGERS), async (c) => {
  const b = await readJson(c);
  const row = issueRow(b);
  if (!b || !isUuid(b.op) || !row || (b.complimentary !== undefined && typeof b.complimentary !== "boolean")
    || (b.release !== undefined && typeof b.release !== "boolean") || (b.cash !== undefined && typeof b.cash !== "boolean")) {
    return json(c, 400, { error: "invalid_request" });
  }
  const { sess } = sessOf(c);
  const id = base32((await sha256(`sahra-issue-v1|${sess.partyId}|${b.op}`)).subarray(0, 10), 16);
  const r = await issueOne(c, { id, ...row, complimentary: b.complimentary === true && b.cash !== true, release: b.release === true, cash: b.cash === true });
  if (r.refusal) return r.refusal;
  await flushChangeLog(c.var.db, c.var.ledger, sessOf(c).now, [id]);
  return json(c, r.status === "created" ? 201 : 200, { status: r.status, ticket_id: id, link: r.link });
});

/** One guest of an issue or import request, validated; null when a field is wrong. */
function issueRow(b: Record<string, unknown> | null) {
  if (!b) return null;
  const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  const email = b.email === undefined || b.email === null || b.email === "" ? null : guestEmail(b.email);
  const people = b.people === undefined ? 1 : b.people;
  const typeId = b.type_id === undefined || b.type_id === null || b.type_id === "" ? null : b.type_id;
  if (name.length < 1 || name.length > 80 || (b.email && !email) || typeof people !== "number" || !Number.isInteger(people)
    || people < 1 || people > 100 || (typeId !== null && !isTypeId(typeId))) return null;
  return { name, email, people, typeId: typeId as string | null };
}

/**
 * Issues one approved ticket (staff-issued, or a cash guest): the same capacity,
 * type and people rules as a guest request, inside the INSERT (GuestDb.issue).
 * With `release`, the QR is sent (email in the same batch when there is an address).
 */
async function issueOne(c: Ctx, a: { id: string; name: string; email: string | null; people: number; typeId: string | null;
  complimentary: boolean; release: boolean; cash: boolean }): Promise<{ status: "created" | "already" | string; link: string; refusal?: Response }> {
  const { sess, actor, now } = sessOf(c);
  const gdb = new GuestDb(c.var.db.driver);
  const env = envRecord(c);
  const link = linkPath(await signLink(env, { partyId: sess.partyId, ticketId: a.id, version: 1 }));
  if (await gdb.ticket(sess, a.id, now)) return { status: "already", link };
  const over = await chargeStaff(c, "issue", 1, MANAGERS);
  if (over) return { status: "limited", link, refusal: over };
  let mail: OutboxRow | null = null;
  if (a.release && a.email) {
    const party = await new PartyDb(c.var.db.driver).get(sess.partyId);
    const signed = await signLink(env, { partyId: sess.partyId, ticketId: a.id, version: 1 });
    mail = releasedEmail({ origin: c.env.PUBLIC_ORIGIN, partyId: sess.partyId, partyName: party?.name ?? "", ticketId: a.id, to: a.email,
      guestName: a.name, people: a.people, link: signed, now, actor, templates: await emailTemplates(c.var.db.driver, sess.partyId) });
  }
  const r = await gdb.issue(sess, { id: a.id, name: a.name, email: a.email, people: a.people, typeId: a.typeId, complimentary: a.complimentary,
    release: a.release, mail, cash: a.cash }, now, actor, newId());
  if (r === "created" || r === "already") return { status: r, link };
  return { status: r === "refused" ? "not_allowed" : r, link,
    refusal: json(c, r === "too_many_people" ? 400 : 409, { error: r === "refused" ? "not_allowed" : r }) };
}

/**
 * Cash guests from a CSV file (brainstorm ideas 9 and 17), in chunks of at most
 * IMPORT_CHUNK rows per request (each row is one guarded batch, like /issue). The
 * page parses the file, shows the preview and the summary, and sends the rows
 * only after "Confirm". Body: op (UUID for the whole file), start (the first row's
 * index in the file), release (send QRs now, or add only), rows: [{ name, email,
 * people, type_id }]. A retry of the same op and start creates nobody twice (the
 * ticket id comes from op + row index). Answer: one result per row.
 */
// About 5 database queries per row (exists check, counter, party and email text when sending, the batch): 5 rows stay well under the free plan's 50 per request.
export const IMPORT_CHUNK = 5;
ticketRoutes.post("/import", requireAuth(MANAGERS), async (c) => {
  const b = await readJson(c);
  const rows = Array.isArray(b?.rows) ? (b!.rows as unknown[]) : null;
  const start = b?.start;
  if (!b || !isUuid(b.op) || typeof b.release !== "boolean" || !rows || rows.length < 1 || rows.length > IMPORT_CHUNK
    || typeof start !== "number" || !Number.isInteger(start) || start < 0 || start > 5000) {
    return json(c, 400, { error: "invalid_request", max_rows: IMPORT_CHUNK });
  }
  const { sess, now } = sessOf(c);
  const results: { row: number; status: string; ticket_id?: string }[] = [];
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = issueRow(typeof rows[i] === "object" && rows[i] !== null ? (rows[i] as Record<string, unknown>) : null);
    if (!row) { results.push({ row: start + i, status: "invalid" }); continue; }
    const id = base32((await sha256(`sahra-import-v1|${sess.partyId}|${b.op}|${start + i}`)).subarray(0, 10), 16);
    const r = await issueOne(c, { id, ...row, complimentary: false, release: b.release, cash: true });
    if (r.status === "limited") { results.push({ row: start + i, status: "limited" }); break; }
    results.push({ row: start + i, status: r.status, ticket_id: r.status === "created" || r.status === "already" ? id : undefined });
    if (r.status === "created" || r.status === "already") ids.push(id);
  }
  if (ids.length) await flushChangeLog(c.var.db, c.var.ledger, now, ids);
  return json(c, 200, { results });
});

/** Find a guest: `q` = ticket id, email (starts with) or name (contains). At most 20, newest first. */
ticketRoutes.get("/search", requireAuth(MANAGERS), async (c) => {
  const q = (c.req.query("q") ?? "").trim().replace(/\s+/g, " ");
  if (q.length < 2 || q.length > 80) return json(c, 400, { error: "invalid_request", q: "2..80 characters" });
  const { sess, now } = sessOf(c);
  const rows = await new GuestDb(c.var.db.driver).search(sess, q, now);
  return json(c, 200, { tickets: rows.map(({ link_version: _v, ...r }) => r) });
});

/**
 * "Resend ticket" (owner/admin, one click): emails the guest their ticket link
 * (the page shows the QR once it is sent). At most one such email per ticket per
 * 10 minutes, checked by the outbox id. The link is also returned, to share by hand.
 */
ticketRoutes.post("/:id/resend", requireAuth(MANAGERS), async (c) => {
  const id = c.req.param("id");
  if (!isTicketId(id)) return json(c, 404, { error: "not_found" });
  const { sess, actor, now } = sessOf(c);
  const gdb = new GuestDb(c.var.db.driver);
  const t = await gdb.ticket(sess, id, now);
  if (!t) return json(c, 404, { error: "not_found" });
  const env = envRecord(c);
  const link = await signLink(env, { partyId: sess.partyId, ticketId: id, version: t.link_version });
  if (!t.guest_email) return json(c, 409, { error: "no_email", link: linkPath(link) });
  const over = await chargeStaff(c, "resend_link", 1, MANAGERS);
  if (over) return over;
  const mailId = `staff-link-${(await sha256hex(`${sess.partyId}|${id}|${Math.floor(now / STAFF_RESEND_WINDOW_MS)}`)).slice(0, 32)}`;
  const queued = await gdb.addLinkEmail(linkEmail({
    id: mailId, origin: c.env.PUBLIC_ORIGIN, partyId: sess.partyId, partyName: t.party_name, to: t.guest_email, links: [link],
    ticketId: id, now, createdBy: actor, templates: await emailTemplates(c.var.db.driver, sess.partyId),
  }), [{ id, link_version: t.link_version }]);
  return json(c, 200, { status: queued ? "queued" : "already_queued", link: linkPath(link) });
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

/** The ID photo of one of this party's tickets (when its form asks for one). Owner/admin only, never cached; door staff never. */
ticketRoutes.get("/:id/id-photo", requireAuth(MANAGERS), async (c) => {
  const id = c.req.param("id");
  if (!isTicketId(id)) return json(c, 404, { error: "not_found" });
  const { sess, now } = sessOf(c);
  const key = await new GuestDb(c.var.db.driver).idPhotoKey(sess, id, now);
  if (!key) return json(c, 404, { error: "not_found" });
  const f = await getIdPhoto(c.env, key, sess.partyId, id);
  if (f === "not_configured") return json(c, 503, { error: "uploads_not_configured" });
  if (!f) return json(c, 404, { error: "not_found" });
  if ("deleted" in f) return json(c, 410, { error: "id_photo_deleted", message: f.deleted });
  return new Response(f.bytes, {
    headers: { "content-type": f.type, "cache-control": "no-store, private", "content-disposition": "inline", "x-content-type-options": "nosniff" },
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
    // A changed address: the old one is told (its link stops working), without showing the new one.
    const oldNotice = email && t.guest_email && email !== t.guest_email ? emailChangedNotice({ id: newId(), partyId: sess.partyId,
      partyName: t.party_name, to: t.guest_email, ticketId: id, now, createdBy: actor,
      contact: (await new PartyDb(c.var.db.driver).get(sess.partyId))?.support_phone ?? null }) : null;
    await recordIntent(c.var.ledger, op, sess.partyId, "name_transferred", [{ entity: "ticket", id }], now);
    if (!(await gdb.transfer(sess, { id, name, email, fromLinkVersion: t.link_version, linkEmail: mail, oldNotice }, now, actor, op))) {
      return json(c, 409, { error: "not_allowed" });
    }
    status = "done";
  }
  await flushChangeLog(c.var.db, c.var.ledger, now, [id]);
  return json(c, 200, { status, link: linkPath(await signLink(env, { partyId: sess.partyId, ticketId: id, version })) });
});
