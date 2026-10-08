// Guest endpoints (no staff session). Sign-up and "resend my ticket link" are the
// only unauthenticated writes besides door join: both are behind Turnstile,
// verified BEFORE any database access, and rate limited per IP. The ticket page
// is read-only and checks the link's signature before touching the database.
//
// Sign-up order of work:
//  1. Origin, rate limit per IP, size limit (Content-Length) - no database.
//  2. Parse and check the fields and the screenshot (size, type from its first bytes).
//  3. Turnstile (siteverify). Missing secret -> 503; failure -> 403. No write before this.
//  4. One read: the party, its form, places held, and whether this sign-up exists (a retry).
//  5. Screenshot into FILES (separate database), under an id derived from the
//     sign-up token, so a retry rewrites the same row (a no-op).
//  6. One main-database batch: insert the pending ticket only if the party has room
//     (src/guests/db.ts), audit, read back.
//  7. Change log (ledger). Not confirmed -> 503 pending; the retry (same sign-up
//     token, new Turnstile token) finishes it without a second ticket.

import { Hono } from "hono/tiny";
import { flushChangeLog } from "../changelog";
import { json, readJson, type AppEnv, type Ctx } from "../context";
import { D1Driver } from "../db/driver";
import { GuestDb } from "../guests/db";
import { linkEmail } from "../guests/emails";
import { checkAnswers, storedForm } from "../guests/form";
import { linkPath, signLink, verifyLink } from "../guests/link";
import { turnstileConfigured, verifyTurnstile } from "../guests/turnstile";
import { base32, parseToken, sha256, sha256hex } from "../lib/crypto";
import { clientIp, rateLimited, sameOrigin } from "../lib/http";
import { signQr } from "../qr";
import { FileStore, MAX_FILE_BYTES, sniffImage } from "../storage";

export const guestRoutes = new Hono<AppEnv>();

const PARTY_RE = /^[a-z0-9-]{3,24}$/;
/** The whole multipart request: the screenshot plus room for the other fields. */
const MAX_SIGNUP_BYTES = MAX_FILE_BYTES + 64 * 1024;
const MAX_ANSWERS_JSON = 16 * 1024;
/** One "resend my link" email per address per party per window (see GuestDb.addLinkEmail). */
const LINK_EMAIL_WINDOW_MS = 10 * 60_000;

function envRecord(c: Ctx): Record<string, unknown> {
  return c.env as unknown as Record<string, unknown>;
}

export function guestEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@"<>]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) ? e : null;
}

function guestName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s.length >= 1 && s.length <= 80 ? s : null;
}

/**
 * Ticket id and screenshot file id from the browser's sign-up token (256 bits,
 * saved by the browser until the sign-up is confirmed). Only that browser can
 * produce these ids, so a retry is recognized as the same sign-up.
 */
async function signupIds(partyId: string, token: string) {
  const h = await sha256(`sahra-signup-v1|${partyId}|${token}`);
  let n = 0;
  for (const b of h.subarray(10, 16)) n = n * 256 + b;
  return { ticketId: base32(h.subarray(0, 10), 16), fileId: n + 1 };
}

function turnstileAnswer(c: Ctx, r: "failed" | "not_configured" | "unavailable") {
  if (r === "not_configured") return json(c, 503, { error: "bot_check_not_configured" });
  if (r === "unavailable") return json(c, 503, { error: "bot_check_unavailable", retry: true });
  return json(c, 403, { error: "bot_check_failed" });
}

/** The public sign-up form: party name, questions, people per ticket, whether it is full. Read-only. */
guestRoutes.get("/parties/:party", async (c) => {
  const partyId = c.req.param("party");
  if (!PARTY_RE.test(partyId)) return json(c, 404, { error: "not_found" });
  const p = await new GuestDb(c.var.db.driver).signupParty(partyId, "");
  if (!p) return json(c, 404, { error: "not_found" });
  const form = storedForm(p.guest_form);
  return json(c, 200, {
    party: { id: p.id, name: p.name },
    form,
    max_people_per_ticket: p.max_people_per_ticket,
    places_left: Math.max(0, p.capacity - p.held),
    full: p.held >= p.capacity,
    uploads: !!c.env.FILES,
    turnstile_site_key: turnstileConfigured(c.env) ? c.env.TURNSTILE_SITE_KEY : null,
  });
});

guestRoutes.post("/parties/:party/signup", async (c) => {
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c, 403, { error: "bad_origin" });
  const ip = clientIp(c);
  if (await rateLimited(c.env.RL_AUTH, `signup:${ip}`)) return json(c, 429, { error: "rate_limited" });
  const partyId = c.req.param("party");
  if (!PARTY_RE.test(partyId)) return json(c, 404, { error: "not_found" });
  const len = Number(c.req.header("content-length") ?? NaN);
  if (!Number.isFinite(len)) return json(c, 411, { error: "length_required" });
  if (len > MAX_SIGNUP_BYTES) return json(c, 413, { error: "too_large", max_screenshot_bytes: MAX_FILE_BYTES });
  if (!(c.req.header("content-type") ?? "").startsWith("multipart/form-data")) return json(c, 400, { error: "invalid_request" });

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return json(c, 400, { error: "invalid_request" });
  }
  const token = form.get("signup");
  const name = guestName(form.get("name"));
  const email = guestEmail(form.get("email"));
  const people = Number(form.get("people") ?? 1);
  const answersText = form.get("answers");
  const file = form.get("screenshot");
  if (typeof token !== "string" || !parseToken(token) || !name || !email || !Number.isInteger(people) || people < 1 || people > 100) {
    return json(c, 400, { error: "invalid_request" });
  }
  let answersRaw: unknown = {};
  if (answersText !== null) {
    if (typeof answersText !== "string" || answersText.length > MAX_ANSWERS_JSON) return json(c, 400, { error: "invalid_request" });
    try {
      answersRaw = JSON.parse(answersText);
    } catch {
      return json(c, 400, { error: "invalid_request" });
    }
  }
  let shot: { bytes: Uint8Array; type: NonNullable<ReturnType<typeof sniffImage>> } | null = null;
  if (file !== null && typeof file !== "string") {
    if (file.size > MAX_FILE_BYTES) return json(c, 413, { error: "too_large", max_screenshot_bytes: MAX_FILE_BYTES });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type || bytes.length === 0) return json(c, 415, { error: "screenshot_must_be_jpeg_png_or_webp" });
    shot = { bytes, type };
  } else if (file !== null) {
    return json(c, 400, { error: "invalid_request" });
  }
  // Fail closed: without the files database a screenshot cannot be kept.
  if (shot && !c.env.FILES) return json(c, 503, { error: "uploads_not_configured" });

  const bot = await verifyTurnstile(c.var.deps.fetch, c.env, form.get("cf-turnstile-response"), ip);
  if (bot !== "ok") return turnstileAnswer(c, bot);

  const gdb = new GuestDb(c.var.db.driver);
  const { ticketId, fileId } = await signupIds(partyId, token);
  const party = await gdb.signupParty(partyId, ticketId);
  if (!party) return json(c, 404, { error: "not_found" });
  const now = c.var.deps.now();
  const env = envRecord(c);
  const done = async (status: number) => {
    await flushChangeLog(c.var.db, c.var.ledger, now, [ticketId]);
    const link = await signLink(env, { partyId, ticketId, version: 1 });
    return json(c, status, { status: "requested", ticket_id: ticketId, link: linkPath(link) });
  };
  // A retry of a sign-up that was already stored: finish its change log only.
  if (party.existing_party === partyId) return done(200);
  if (party.existing_party !== null) return json(c, 409, { error: "invalid_request" });

  const pf = storedForm(party.guest_form);
  const answers = checkAnswers(pf, answersRaw);
  if (!answers) return json(c, 400, { error: "invalid_answers" });
  if (people > party.max_people_per_ticket) return json(c, 400, { error: "too_many_people", max_people_per_ticket: party.max_people_per_ticket });
  if (pf.screenshot === "required" && !shot) return json(c, 400, { error: "screenshot_required" });
  if (pf.screenshot === "none" && shot) return json(c, 400, { error: "screenshot_not_wanted" });
  // Early answer when already full (the insert below re-checks in the same statement).
  if (party.held + people > party.capacity) return json(c, 409, { error: "full" });

  let screenshotKey: string | null = null;
  if (shot) {
    screenshotKey = await new FileStore(new D1Driver(c.env.FILES!)).put({
      id: fileId, partyId, ticketId, type: shot.type, bytes: shot.bytes, now,
    });
  }
  const r = await gdb.signup({
    id: ticketId, partyId, people, name, email, answers: Object.keys(answers).length ? JSON.stringify(answers) : null,
    screenshotKey, now, op: crypto.randomUUID(),
  });
  // A screenshot stored for a sign-up that then found the party full stays as an
  // orphan row (no ticket points to it); it is never served (reads need the ticket).
  if (r === "full") return json(c, 409, { error: "full" });
  if (r === "refused") return json(c, 409, { error: "not_allowed" });
  return done(r === "created" ? 201 : 200);
});

/**
 * "Resend my ticket link" (feature 12). The answer is the same whether or not the
 * address has a ticket. Rate limited per IP and per address; at most one email per
 * address per party per 10 minutes (checked in the insert).
 */
guestRoutes.post("/parties/:party/resend", async (c) => {
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c, 403, { error: "bad_origin" });
  const ip = clientIp(c);
  if (await rateLimited(c.env.RL_AUTH, `resend:${ip}`)) return json(c, 429, { error: "rate_limited" });
  const partyId = c.req.param("party");
  const b = await readJson(c);
  const email = guestEmail(b?.email);
  if (!PARTY_RE.test(partyId) || !email) return json(c, 400, { error: "invalid_request" });
  if (await rateLimited(c.env.RL_AUTH, `resend-email:${await sha256hex(`${partyId}|${email}`)}`)) return json(c, 429, { error: "rate_limited" });
  const bot = await verifyTurnstile(c.var.deps.fetch, c.env, b?.turnstile, ip);
  if (bot !== "ok") return turnstileAnswer(c, bot);

  const gdb = new GuestDb(c.var.db.driver);
  const tickets = await gdb.ticketsByEmail(partyId, email);
  if (tickets.length > 0) {
    const now = c.var.deps.now();
    const env = envRecord(c);
    const links = [];
    for (const t of tickets) links.push(await signLink(env, { partyId, ticketId: t.id, version: t.link_version }));
    const id = `link-${(await sha256hex(`${partyId}|${email}|${Math.floor(now / LINK_EMAIL_WINDOW_MS)}`)).slice(0, 32)}`;
    await gdb.addLinkEmail(linkEmail({
      id, origin: c.env.PUBLIC_ORIGIN, partyId, partyName: tickets[0]!.party_name, to: email, links,
      ticketId: tickets.length === 1 ? tickets[0]!.id : null, now, createdBy: null,
    }), tickets);
  }
  return json(c, 200, { status: "ok", message: "If this address has a ticket for this party, its link is on the way." });
});

/**
 * The guest's ticket page. The signed link comes in the x-sahra-ticket header (the
 * page reads it from the URL fragment). The QR code is included only when the
 * ticket is approved, released and not on hold.
 */
guestRoutes.get("/ticket", async (c) => {
  const env = envRecord(c);
  const p = await verifyLink(env, c.req.header("x-sahra-ticket"));
  if (!p) return json(c, 404, { error: "invalid_link" });
  const t = await new GuestDb(c.var.db.driver).guestTicket(p.partyId, p.ticketId);
  if (!t || t.link_version !== p.version) return json(c, 404, { error: "invalid_link" });
  const released = t.status === "approved" && t.released_at != null;
  const showQr = released && t.hold_at == null;
  return json(c, 200, {
    // TODO(integration): the coordinator wires workstream A's
    // visiblePartyDetails(party, viewer, now) (src/party/details.ts) here.
    party: { id: t.party_id, name: t.party_name },
    ticket: {
      id: t.id,
      status: released ? "released" : t.status,
      guest_name: t.guest_name,
      people: t.people,
      reject_reason: t.status === "rejected" ? t.reject_reason : null,
      on_hold: t.hold_at != null,
      used: t.used_at != null,
      qr: showQr ? await signQr(env, { partyId: t.party_id, ticketId: t.id, version: t.qr_version }) : null,
    },
  });
});
