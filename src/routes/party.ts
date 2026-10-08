// Party details (Phase 4 workstream A): view and edit, "Reveal now", and the
// public party page's data. The place (venue, address, map link) is decided on
// the server by visiblePartyDetails (src/party/details.ts); a hidden place never
// reaches the browser.
//
// Edits are owner/admin, go through rev + last_op + audit + the change log, and
// are confirmed only after flushChangeLog succeeds (otherwise 503 "pending";
// a retry with the same body changes nothing more and completes the log write).

import { Hono } from "hono/tiny";
import { flushChangeLog } from "../changelog";
import { json, readJson, requireAuth, type AppEnv } from "../context";
import { isUuid, newId } from "../lib/crypto";
import { GuestDb } from "../guests/db";
import { isTypeId } from "../guests/types";
import { chargeStaff } from "../limits";
import { PartyDb } from "../party/db";
import { doorView, staffView, visiblePartyDetails, type Viewer } from "../party/details";
import { parseEdit, text, TIME_OR_PLACE } from "../party/input";
import { announceText, AUDIENCES, noticeText, type Audience } from "../party/notice";

export const partyRoutes = new Hono<AppEnv>();

function partyDb(c: { var: AppEnv["Variables"] }) {
  return new PartyDb(c.var.db.driver);
}

/** The session's party: owners/admins see everything, door staff what the door needs. */
partyRoutes.get("/", requireAuth(["owner", "admin", "door"]), async (c) => {
  const a = c.var.auth;
  const p = await partyDb(c).get(a.info.party_id);
  if (!p) return json(c, 404, { error: "not_found" });
  return json(c, 200, a.info.role === "door" ? doorView(p) : staffView(p, c.var.deps.now()));
});

/**
 * Edit details (owner/admin). Body: any of the editable fields (src/party/input.ts),
 * plus `notify_guests: true` to queue a notice (awaiting approval) to every
 * approved, released ticket holder when the time or place changes.
 */
partyRoutes.post("/details", requireAuth(["owner", "admin"]), async (c) => {
  const b = await readJson(c);
  if (!b) return json(c, 400, { error: "invalid_request" });
  const parsed = parseEdit(b);
  if (!parsed.ok) return json(c, 400, { error: parsed.error });
  const a = c.var.auth;
  const now = c.var.deps.now();
  const db = partyDb(c);
  let notice: null | { subject: string; body: string } = null;
  if (parsed.notify) {
    if (!TIME_OR_PLACE.some((f) => f in parsed.values)) return json(c, 400, { error: "notify_needs_time_or_place_change" });
    // The text shows the new times; it is built from the row as it will be after this edit.
    const cur = await db.get(a.info.party_id);
    if (!cur) return json(c, 404, { error: "not_found" });
    notice = noticeText({ ...cur, ...(parsed.values as Partial<typeof cur>) });
    const over = await chargeStaff(c, "notice", 1);
    if (over) return over;
  }
  const r = await db.edit({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, parsed.values, now, newId(), notice);
  if (r.status === "rejected") {
    const code = r.reason === "end_before_start" || r.reason === "reveal_time_required" || r.reason === "registration_close_before_open" ? 400 : 409;
    return json(c, code, { error: r.reason, ...(r.held !== undefined ? { held: r.held } : {}) });
  }
  await flushChangeLog(c.var.db, c.var.ledger, now);
  const p = await db.get(a.info.party_id);
  return json(c, 200, {
    status: r.status,
    party: p ? staffView(p, now) : null,
    ...(r.notices !== null ? { notices_queued: r.notices, notices_not_queued: r.notices_not_queued } : {}),
  });
});

/** "Reveal now" (manual address mode). */
partyRoutes.post("/reveal", requireAuth(["owner", "admin"]), async (c) => {
  const a = c.var.auth;
  const now = c.var.deps.now();
  const r = await partyDb(c).revealNow({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, now, newId());
  if (r.status === "rejected") return json(c, 409, { error: r.reason });
  await flushChangeLog(c.var.db, c.var.ledger, now);
  return json(c, 200, r);
});

/**
 * Owner/admin preview of what a viewer would see (test page): `viewer=public` or
 * `viewer=ticket&status=approved&released=1&on_hold=0`, optional `at` (Unix ms).
 * Read-only.
 */
partyRoutes.get("/preview", requireAuth(["owner", "admin"]), async (c) => {
  const q = (k: string) => c.req.query(k);
  const at = q("at") === undefined ? c.var.deps.now() : Number(q("at"));
  if (!Number.isSafeInteger(at)) return json(c, 400, { error: "invalid_request" });
  let viewer: Viewer;
  if (q("viewer") === "public") viewer = { kind: "public" };
  else if (q("viewer") === "ticket") viewer = { kind: "ticket", status: String(q("status") ?? ""), released: q("released") === "1", onHold: q("on_hold") === "1" };
  else return json(c, 400, { error: "invalid_request" });
  const p = await partyDb(c).get(c.var.auth.info.party_id);
  if (!p) return json(c, 404, { error: "not_found" });
  return json(c, 200, visiblePartyDetails(p, viewer, at));
});

/** Public party page data. No session; reads one row; writes nothing. */
partyRoutes.get("/public/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json(c, 404, { error: "not_found" });
  const p = await partyDb(c).get(id);
  if (!p) return json(c, 404, { error: "not_found" });
  return json(c, 200, visiblePartyDetails(p, { kind: "public" }, c.var.deps.now()));
});

/**
 * Announcement to guests (owner/admin): free text, queued in the outbox awaiting
 * approval like a guest notice (nothing is sent from here). Body: op (UUID; a
 * retry queues nobody twice), subject, body, audience ("released": QR sent,
 * default; "approved"; "everyone": pending too), type_id (optional).
 */
partyRoutes.post("/announce", requireAuth(["owner", "admin"]), async (c) => {
  const b = await readJson(c);
  const subject = text(b?.subject, 150, false);
  const body = text(b?.body, 3000, true);
  const audience = (b?.audience ?? "released") as Audience;
  const typeId = b?.type_id === undefined || b?.type_id === null ? null : b.type_id;
  if (!b || !isUuid(b.op) || !subject || !body || !AUDIENCES.includes(audience) || (typeId !== null && !isTypeId(typeId))) {
    return json(c, 400, { error: "invalid_request", audience: AUDIENCES });
  }
  const a = c.var.auth;
  const now = c.var.deps.now();
  const over = await chargeStaff(c, "announce", 1);
  if (over) return over;
  const mail = announceText(a.info.party_name, subject, body);
  const r = await partyDb(c).announce({ hash: a.hash, partyId: a.info.party_id }, { op: b.op, audience, typeId, ...mail }, a.info.staff_id, now);
  if (!r.ok) return json(c, 401, { error: "not_signed_in" });
  return json(c, 200, { status: "awaiting_approval", queued: r.queued, not_queued: Math.max(0, r.recipients - r.queued) });
});

/**
 * The capacity indicator and check-in figures (owner, admin and door): places
 * held and left, per ticket type, money expected, admissions per 15 minutes and
 * per scanner, requests per hour over 30 days. Reads the party's tickets three
 * times; poll it once a minute at most.
 */
partyRoutes.get("/stats", requireAuth(["owner", "admin", "door"]), async (c) => {
  const a = c.var.auth;
  const now = c.var.deps.now();
  const s = await new GuestDb(c.var.db.driver).stats({ hash: a.hash, partyId: a.info.party_id }, now, ["owner", "admin", "door"]);
  if (s.byType.length === 0) return json(c, 401, { error: "not_signed_in" });
  const capacity = s.byType[0]!.capacity;
  const sum = (k: "tickets" | "pending" | "approved" | "released" | "admitted" | "admitted_tickets" | "money_approved" | "money_pending") =>
    s.byType.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  const held = sum("pending") + sum("approved");
  const names = new Map(s.types.map((t) => [t.id, t]));
  const byType = s.byType.filter((r) => r.type_id !== null || Number(r.tickets) > 0).map((r) => {
    const t = r.type_id ? names.get(r.type_id) : undefined;
    return {
      type_id: r.type_id, name: r.type_name ?? (r.type_id ? "?" : "No type"), quantity: t?.quantity ?? null,
      pending: r.pending, approved: r.approved, released: r.released, admitted: r.admitted,
      places_left: t && t.quantity !== null ? Math.max(0, t.quantity - r.pending - r.approved) : null,
    };
  });
  // Types without any ticket yet.
  for (const t of s.types) {
    if (t.archived_at === null && !byType.some((r) => r.type_id === t.id)) {
      byType.push({ type_id: t.id, name: t.name, quantity: t.quantity, pending: 0, approved: 0, released: 0, admitted: 0, places_left: t.quantity });
    }
  }
  const slots = new Map<number, { at: number; tickets: number; people: number }>();
  const scanners = new Map<string, { staff_id: string | null; name: string | null; tickets: number; people: number }>();
  for (const r of s.slots) {
    const slot = slots.get(r.slot) ?? { at: r.slot * 900_000, tickets: 0, people: 0 };
    slot.tickets += Number(r.tickets);
    slot.people += Number(r.people);
    slots.set(r.slot, slot);
    const key = r.used_by ?? "";
    const sc = scanners.get(key) ?? { staff_id: r.used_by, name: r.scanner, tickets: 0, people: 0 };
    sc.tickets += Number(r.tickets);
    sc.people += Number(r.people);
    scanners.set(key, sc);
  }
  return json(c, 200, {
    at: now,
    capacity,
    held,
    places_left: Math.max(0, capacity - held),
    pending: sum("pending"),
    approved: sum("approved"),
    released: sum("released"),
    inside: sum("admitted"),
    admitted_tickets: sum("admitted_tickets"),
    // Whole EGP: price per person shown at request time x people (staff-issued complimentary = 0).
    money_expected: sum("money_approved"),
    money_pending: sum("money_pending"),
    by_type: byType,
    check_ins_per_15_min: [...slots.values()],
    requests_per_hour: s.hours.map((h) => ({ at: h.hour * 3_600_000, requests: Number(h.requests), people: Number(h.people) })),
    by_scanner: [...scanners.values()].sort((x, y) => y.people - x.people),
  });
});
