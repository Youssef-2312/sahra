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
import { newId } from "../lib/crypto";
import { PartyDb } from "../party/db";
import { doorView, staffView, visiblePartyDetails, type Viewer } from "../party/details";
import { parseEdit, TIME_OR_PLACE } from "../party/input";
import { noticeText } from "../party/notice";

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
  }
  const r = await db.edit({ hash: a.hash, partyId: a.info.party_id }, a.info.staff_id, parsed.values, now, newId(), notice);
  if (r.status === "rejected") {
    const code = r.reason === "end_before_start" || r.reason === "reveal_time_required" ? 400 : 409;
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
