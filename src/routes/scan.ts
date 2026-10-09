// Door scanning (section 7). Rule shown to staff: NO GREEN, NO ENTRY.
//
// Verdicts: admit (name, people, type) | used (when, by, type) | stop (reason) | paused |
// cant_verify | recording (retry with the SAME scan id) | not_signed_in.
//
// Order of work:
//  1. Session cookie + Origin + CSRF (no database), rate limit per scanner session.
//  2. QR signature (no database). Invalid -> stop "invalid code".
//  3. Read the party's control object (ledger). Missing or paused -> paused.
//  4. One main-database batch: mark used if every rule holds, insert the scan row
//     with its final outcome, read back (src/db/tickets.ts).
//  5. Admitted: ONE ledger batch writes the admission record (entity + rev,
//     idempotent) and re-reads the control object. Green only if that batch
//     succeeded and the party is still open with the same pause_number.
//     Ledger failure -> recording; the scanner retries with the same scan id and
//     the retry finishes step 5 before it can return green.

import { Hono } from "hono/tiny";
import { json, readJson, requireAuth, type AppEnv, type Ctx } from "../context";
import { TicketDb } from "../db/tickets";
import { csrfFor, isBase32, isUuid, newId, parseToken, sha256hex, timingSafeEqualStr } from "../lib/crypto";
import { COOKIE_SESSION, rateLimited, readCookie, sameOrigin } from "../lib/http";
import { formatHuman } from "../party/time";
import { verifyQr } from "../qr";

export const scanRoutes = new Hono<AppEnv>();

const reasonText: Record<string, string> = {
  not_approved: "not approved",
  not_released: "QR not sent yet",
  old_version: "old QR (ticket was reissued)",
  unknown_ticket: "unknown ticket",
};

function verdict(c: Ctx, body: Record<string, unknown>) {
  return json(c, 200, body);
}

scanRoutes.post("/", async (c) => {
  // 1. Who is scanning. The session is checked again inside the database batch.
  const raw = readCookie(c, COOKIE_SESSION);
  const token = raw ? parseToken(raw) : null;
  if (!raw || !token) return verdict(c, { verdict: "not_signed_in" });
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c, 403, { error: "bad_origin" });
  if (!timingSafeEqualStr(c.req.header("x-sahra-csrf") ?? "", await csrfFor(token))) return json(c, 403, { error: "bad_csrf" });
  const sessionHash = await sha256hex(raw);
  // Keyed per scanner session (never per IP: door phones on one Wi-Fi share an IP).
  if (await rateLimited(c.env.RL_SCAN, `scan:${sessionHash}`, "open")) {
    return verdict(c, { verdict: "cant_verify", reason: "too many scans from this phone, wait a moment" });
  }

  const b = await readJson(c);
  if (!b || !isUuid(b.scan_id) || typeof b.qr !== "string") return json(c, 400, { error: "invalid_request" });
  const qrText = b.qr.trim();

  // 2. Signature before any database access.
  const qr = await verifyQr(c.env as unknown as Record<string, unknown>, qrText);
  if (!qr) return verdict(c, { verdict: "stop", reason: "invalid code" });

  return admission(c, { scanId: b.scan_id, partyId: qr.partyId, sessionHash, ticketId: qr.ticketId, qrVersion: qr.version,
    fingerprint: await sha256hex(qrText), manualBy: null });
});

/**
 * Steps 3 to 5, shared by a QR scan and a manual admit (the same single-use
 * redemption: there is no second way in). `fingerprint` is the QR text's SHA-256,
 * or "manual" for a manual admit, whose staff member is then recorded in the
 * audit log in the redemption batch.
 */
async function admission(c: Ctx, a: { scanId: string; partyId: string; sessionHash: string; ticketId: string; qrVersion: number;
  fingerprint: string; manualBy: string | null }) {
  const b = { scan_id: a.scanId };
  const qr = { partyId: a.partyId, ticketId: a.ticketId, version: a.qrVersion };
  const { sessionHash, fingerprint } = a;
  // 3. Control object (outside the main database).
  let control;
  try {
    control = await c.var.ledger.getControl(qr.partyId);
  } catch {
    return verdict(c, { verdict: "cant_verify" });
  }
  if (!control || control.state !== "open") return verdict(c, { verdict: "paused" });

  // 4. The redemption batch.
  const now = c.var.deps.now();
  let r;
  try {
    r = await new TicketDb(c.var.db.driver).redeem({
      scanId: b.scan_id, partyId: qr.partyId, sessionHash, ticketId: qr.ticketId, qrVersion: qr.version,
      fingerprint, pauseNumber: control.pause_number, now, op: newId(), manualBy: a.manualBy,
    });
  } catch {
    return verdict(c, { verdict: "cant_verify" });
  }

  const scan = r.scan;
  if (!scan) {
    if (r.sessionParty && r.sessionParty !== qr.partyId) return verdict(c, { verdict: "stop", reason: "ticket is for another party" });
    return verdict(c, { verdict: "not_signed_in" });
  }
  // A scan id already stored for a different ticket, code, scanner or party.
  if (scan.party_id !== qr.partyId || scan.ticket_id !== qr.ticketId || scan.qr_fingerprint !== fingerprint
    || scan.session_hash !== sessionHash || scan.qr_version !== qr.version) {
    return verdict(c, { verdict: "stop", reason: "scan id conflict" });
  }

  if (scan.outcome !== "admitted") {
    if (!r.sessionOk) return verdict(c, { verdict: "not_signed_in" });
    if (scan.outcome === "already_used") {
      return verdict(c, { verdict: "used", when: r.ticket?.used_at ?? null, by: r.usedByName, type: r.typeName });
    }
    // A ticket type with an entry time still to come (see TicketDb.redeem).
    if (scan.outcome === "paused" && r.typeEntryFrom != null && r.typeEntryFrom > scan.created_at) {
      const at = formatHuman(r.typeEntryFrom, r.partyTimeZone ?? "UTC");
      return verdict(c, { verdict: "stop", reason: `too early: ${r.typeName ?? "this ticket"} enters from ${at}`, entry_from: r.typeEntryFrom, type: r.typeName });
    }
    if (scan.outcome === "paused") return verdict(c, { verdict: "paused" });
    if (r.ticket?.hold_at != null) return verdict(c, { verdict: "stop", reason: "ticket on hold after a database recovery, ask the owner" });
    return verdict(c, { verdict: "stop", reason: reasonText[scan.outcome] ?? scan.outcome });
  }

  // 5. Admitted in the main database: the admission record must be confirmed in the
  // ledger, and the party still open with the same pause_number, before green.
  const t = r.ticket;
  if (!t || scan.ticket_rev == null || t.rev !== scan.ticket_rev || t.used_scan_id !== b.scan_id) {
    // The ticket changed after this admission (for example a privileged reset)
    // before its record reached the ledger: this scan never showed green.
    return verdict(c, { verdict: "stop", reason: "ticket changed, scan again" });
  }
  const { logged_rev: _ignored, ...state } = t;
  let after;
  try {
    after = await c.var.ledger.recordAdmission({
      event_id: `ticket:${t.id}:${t.rev}`,
      party_id: t.party_id,
      entity: "ticket",
      entity_id: t.id,
      rev: t.rev,
      action: "admitted",
      logged_at: now,
      state: JSON.stringify(state),
    });
  } catch {
    return verdict(c, { verdict: "recording" });
  }
  if (!after || after.state !== "open" || after.pause_number !== scan.pause_number) {
    return verdict(c, { verdict: "paused" });
  }
  // The record is written either way; a revoked scanner still gets no green.
  if (!r.sessionOk) return verdict(c, { verdict: "not_signed_in" });
  return verdict(c, { verdict: "admit", name: t.guest_name, people: t.people, type: r.typeName, ...(a.manualBy ? { manual: true } : {}) });
}

// ------------------------------------------------------------- Find guest, manual admit
//
// Brainstorm idea 8: for a guest whose QR will not scan (cracked screen, dead
// phone), door staff search by name and admit by hand. The admit goes through the
// SAME redemption as a scan (admission(): control object, the guarded UPDATE that
// marks the ticket used once, the ledger record, the control object re-read), so
// a ticket can still never be admitted twice and nothing is green while paused or
// unconfirmed. It is marked as manual in the audit log with the staff member.

const SCAN_ROLES = ["door", "admin", "owner"] as const;

/** "m***@example.com": enough to tell two guests with the same name apart. */
function maskEmail(e: string | null): string | null {
  if (!e) return null;
  const at = e.indexOf("@");
  return at < 1 ? null : `${e[0]}***${e.slice(at)}`;
}

scanRoutes.get("/find", requireAuth(SCAN_ROLES), async (c) => {
  const q = (c.req.query("q") ?? "").trim().replace(/\s+/g, " ");
  if (q.length < 2 || q.length > 80) return json(c, 400, { error: "invalid_request" });
  const a = c.var.auth;
  if (await rateLimited(c.env.RL_SCAN, `scan:${a.hash}`, "open")) return json(c, 429, { error: "rate_limited" });
  const rows = await new TicketDb(c.var.db.driver).doorSearch({ hash: a.hash, partyId: a.info.party_id }, q, isBase32(q.toUpperCase(), 16) && q.length === 16, c.var.deps.now());
  return json(c, 200, { tickets: rows.map((t) => ({
    id: t.id, name: t.guest_name, email: maskEmail(t.guest_email), people: t.people, type: t.type_name,
    // What the door can do: only "ready" can be admitted (the server checks again when admitting).
    state: t.used_at ? "used" : t.status !== "approved" ? (t.status === "pending" ? "pending" : t.status)
      : t.hold_at ? "on_hold" : t.released_at ? "ready" : "not_released",
    used_at: t.used_at, used_by: t.used_by_name,
  })) });
});

scanRoutes.post("/manual", requireAuth(SCAN_ROLES), async (c) => {
  const a = c.var.auth;
  if (await rateLimited(c.env.RL_SCAN, `scan:${a.hash}`, "open")) {
    return verdict(c, { verdict: "cant_verify", reason: "too many scans from this phone, wait a moment" });
  }
  const b = await readJson(c);
  const ticketId = typeof b?.ticket_id === "string" ? b.ticket_id : "";
  if (!b || !isUuid(b.scan_id) || !isBase32(ticketId, 16)) return json(c, 400, { error: "invalid_request" });
  let version: number | null;
  try {
    version = await new TicketDb(c.var.db.driver).qrVersionOf(a.info.party_id, ticketId);
  } catch {
    return verdict(c, { verdict: "cant_verify" });
  }
  if (version === null) return verdict(c, { verdict: "stop", reason: reasonText.unknown_ticket });
  return admission(c, { scanId: b.scan_id, partyId: a.info.party_id, sessionHash: a.hash, ticketId, qrVersion: version,
    fingerprint: "manual", manualBy: a.info.staff_id });
});

/** The organiser's review list of manual admits (owner and admin). */
scanRoutes.get("/manual", requireAuth(["owner", "admin"]), async (c) => {
  const a = c.var.auth;
  const rows = await new TicketDb(c.var.db.driver).manualAdmits({ hash: a.hash, partyId: a.info.party_id }, ["owner", "admin"], c.var.deps.now());
  return json(c, 200, { admits: rows });
});
