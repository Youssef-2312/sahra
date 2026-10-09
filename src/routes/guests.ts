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
//  5. Screenshot into the first files database under 70% full (src/storage/), under an id derived from the
//     sign-up token, so a retry rewrites the same row (a no-op).
//  6. One main-database batch: insert the pending ticket only if the party has room
//     (src/guests/db.ts), audit, read back.
//  7. Change log (ledger). Not confirmed -> 503 pending; the retry (same sign-up
//     token, new Turnstile token) finishes it without a second ticket.

import { Hono } from "hono/tiny";
import { flushChangeLog } from "../changelog";
import { json, readJson, type AppEnv, type Ctx } from "../context";
import { D1Driver } from "../db/driver";
import { GuestDb, type SignupParty, type SignupRefusal } from "../guests/db";
import { emailTemplates, groupNote, linkEmail } from "../guests/emails";
import { checkAnswers, storedForm } from "../guests/form";
import { currentPolicy, samePolicy, shownPolicy, type Policy } from "../guests/policy";
import { linkPath, signLink, verifyLink } from "../guests/link";
import { turnstileConfigured, verifyTurnstile } from "../guests/turnstile";
import { isTypeId, TypeDb } from "../guests/types";
import { base32, parseToken, sha256, sha256hex } from "../lib/crypto";
import { clientIp, rateLimited, sameOrigin } from "../lib/http";
import { chargeGuest } from "../limits";
import { PartyDb } from "../party/db";
import { visiblePartyDetails } from "../party/details";
import { FlyerDb, flyerUrl, isFlyerId } from "../party/flyers";
import { getFlyerFile } from "../storage";
import { signQr } from "../qr";
import { FileStore, MAX_FILE_BYTES, sniffImage, uploadTarget, type FilesCapacity } from "../storage";

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

const shotsOk = (cap: FilesCapacity) => cap.state === "ok";

/** Registration state at `now` (party rules, migrations/0014). */
function registration(p: Pick<SignupParty, "registration_opens_at" | "registration_closes_at">, now: number) {
  const notYet = p.registration_opens_at !== null && p.registration_opens_at > now;
  const over = p.registration_closes_at !== null && p.registration_closes_at <= now;
  return { opens_at: p.registration_opens_at, closes_at: p.registration_closes_at, open: !notYet && !over,
    state: notYet ? "not_open_yet" : over ? "closed" : "open" } as const;
}

/** Guest-facing words for a refused request. */
const REFUSAL: Record<SignupRefusal, { status: number; message: string }> = {
  registration_not_open: { status: 409, message: "Requests for this party are not open yet." },
  registration_closed: { status: 409, message: "Requests for this party are closed." },
  email_limit: { status: 409, message: "This email address already has the most tickets allowed for this party." },
  type_required: { status: 400, message: "Please choose a ticket type." },
  type_unavailable: { status: 409, message: "This ticket type is not on sale right now." },
  type_full: { status: 409, message: "This ticket type is sold out." },
  full: { status: 409, message: "This party is full." },
  terms_changed: { status: 409, message: "The terms or this party's rules have changed. Please review them before sending your request." },
  refused: { status: 409, message: "This request cannot be made." },
};

function refusal(c: Ctx, why: SignupRefusal) {
  const r = REFUSAL[why];
  return json(c, r.status, { error: why === "refused" ? "not_allowed" : why, message: r.message });
}

/** The form showed older terms, rules or notice: nothing stored; the current ones, to show and accept again. */
function termsChanged(c: Ctx, rules: string | null, policy: Policy) {
  return json(c, 409, { error: "terms_changed", message: REFUSAL.terms_changed.message, policy, rules });
}

function turnstileAnswer(c: Ctx, r: "failed" | "not_configured" | "unavailable") {
  if (r === "not_configured") return json(c, 503, { error: "bot_check_not_configured" });
  if (r === "unavailable") return json(c, 503, { error: "bot_check_unavailable", retry: true });
  return json(c, 403, { error: "bot_check_failed" });
}

/**
 * The home page's party list (public; no place, no guest data). Kept in this
 * isolate for a minute and cacheable by the browser for a minute, so a busy home
 * page does not re-read the parties on every view.
 */
let listCache: { at: number; body: unknown } | null = null;
const LIST_TTL_MS = 60_000;
guestRoutes.get("/parties", async (c) => {
  const now = c.var.deps.now();
  if (!listCache || now - listCache.at >= LIST_TTL_MS || now < listCache.at) {
    const rows = await new GuestDb(c.var.db.driver).listedParties(now);
    listCache = { at: now, body: { parties: rows.map((p) => {
      const notYet = p.registration_opens_at !== null && p.registration_opens_at > now;
      const over = p.registration_closes_at !== null && p.registration_closes_at <= now;
      const left = Math.max(0, p.capacity - p.held);
      return {
        id: p.id, name: p.name, starts_at: p.starts_at, ends_at: p.ends_at, time_zone: p.time_zone,
        from_price: p.from_price, price_count: p.price_count, places_left: left,
        flyers: p.flyers.map((f) => ({ id: f.id, url: flyerUrl(p.id, f.id, f.rev) })),
        state: left === 0 ? "full" : notYet ? "not_open_yet" : over ? "closed" : "open",
        opens_at: notYet ? p.registration_opens_at : null,
      };
    }) } };
  }
  const res = json(c, 200, listCache.body);
  res.headers.set("cache-control", "public, max-age=60");
  return res;
});

/** Test hook: forget the cached list (tests run many parties in one isolate). */
export function clearPartyListCache() {
  listCache = null;
}

/**
 * Status of the tickets this browser remembers (the home page cards). Body:
 * { links: [signed link, ...] } (at most 20). Each link is checked before any
 * database access; one read for all. A link that does not verify, or whose
 * version was replaced, answers "invalid".
 */
guestRoutes.post("/tickets/status", async (c) => {
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c, 403, { error: "bad_origin" });
  if (await rateLimited(c.env.RL_AUTH, `status:${clientIp(c)}`)) return json(c, 429, { error: "rate_limited" });
  const b = await readJson(c);
  const links = Array.isArray(b?.links) ? b.links.filter((x: unknown) => typeof x === "string").slice(0, 20) as string[] : null;
  if (!links) return json(c, 400, { error: "invalid_request" });
  const env = envRecord(c);
  const verified = await Promise.all(links.map((l) => verifyLink(env, l)));
  const ids = [...new Set(verified.filter((v) => v !== null).map((v) => v!.ticketId))];
  const rows = new Map((await new GuestDb(c.var.db.driver).ticketsForLinks(ids)).map((r) => [r.id, r]));
  return json(c, 200, { tickets: links.map((link, i) => {
    const v = verified[i];
    const t = v ? rows.get(v.ticketId) : undefined;
    if (!v || !t || t.party_id !== v.partyId || t.link_version !== v.version) return { link, status: "invalid" };
    const status = t.used_at != null ? "used" : t.hold_at != null ? "on_hold"
      : t.status === "approved" && t.released_at != null ? "released" : t.status;
    return { link, status, party_id: t.party_id, party_name: t.party_name, starts_at: t.starts_at, time_zone: t.time_zone };
  }) });
});

/**
 * A party picture, for guests: only a live picture of a party that is switched on
 * and not over (one indexed read), served with a long browser cache because the
 * URL carries the picture's rev. Recent pictures are kept in this isolate (a few
 * MB at most), so a busy home page does not read the files database every time.
 */
const flyerCache = new Map<string, { type: string; bytes: Uint8Array }>();
let flyerCacheBytes = 0;
const FLYER_CACHE_MAX = 6_000_000;
guestRoutes.get("/flyers/:party/:id", async (c) => {
  const partyId = c.req.param("party");
  const id = c.req.param("id");
  if (!PARTY_RE.test(partyId) || !isFlyerId(id)) return json(c, 404, { error: "not_found" });
  const now = c.var.deps.now();
  const f = await new FlyerDb(c.var.db.driver).publicFile(partyId, id, now);
  if (!f) return json(c, 404, { error: "not_found" });
  const key = `${partyId}/${id}/${f.rev}`;
  let hit = flyerCache.get(key);
  if (!hit) {
    const stored = await getFlyerFile(c.env, f.file_key, partyId, id);
    if (!stored || stored === "not_configured" || "deleted" in stored) return json(c, 404, { error: "not_found" });
    hit = { type: stored.type, bytes: stored.bytes };
    if (hit.bytes.length <= FLYER_CACHE_MAX / 4) {
      flyerCache.set(key, hit);
      flyerCacheBytes += hit.bytes.length;
      // Oldest first out (a Map keeps insertion order).
      for (const [k, v] of flyerCache) {
        if (flyerCacheBytes <= FLYER_CACHE_MAX) break;
        flyerCache.delete(k);
        flyerCacheBytes -= v.bytes.length;
      }
    }
  }
  return new Response(hit.bytes, { headers: {
    "content-type": hit.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff",
    "content-disposition": "inline",
  } });
});

/** Tests only: forget the cached pictures. */
export function clearFlyerCache() {
  flyerCache.clear();
  flyerCacheBytes = 0;
}

/** The public sign-up form: party name, questions, people per ticket, whether it is full. Read-only. */
guestRoutes.get("/parties/:party", async (c) => {
  const partyId = c.req.param("party");
  if (!PARTY_RE.test(partyId)) return json(c, 404, { error: "not_found" });
  const p = await new GuestDb(c.var.db.driver).signupParty(partyId, "");
  if (!p) return json(c, 404, { error: "not_found" });
  const form = storedForm(p.guest_form);
  const now = c.var.deps.now();
  const partyLeft = Math.max(0, p.capacity - p.held);
  const types = p.has_types ? await new TypeDb(c.var.db.driver).publicList(partyId, now) : [];
  // The public party page's data too (times, description, rules, address status), so the
  // sign-up page needs one request. The place stays hidden unless its mode is public.
  const row = await new PartyDb(c.var.db.driver).get(partyId);
  const flyers = await new FlyerDb(c.var.db.driver).list(partyId);
  return json(c, 200, {
    party: { id: p.id, name: p.name },
    details: row ? visiblePartyDetails(row, { kind: "public" }, now) : null,
    // The party's pictures, in order (the home page card shows the first).
    flyers: flyers.map((f) => ({ id: f.id, url: flyerUrl(partyId, f.id, f.rev) })),
    form,
    max_people_per_ticket: p.max_people_per_ticket,
    places_left: partyLeft,
    full: p.held >= p.capacity,
    registration: registration(p, now),
    max_tickets_per_email: p.max_tickets_per_email,
    payment_instructions: p.payment_instructions,
    // Prices are whole Egyptian pounds per person. A request must name one of these when the list is not empty.
    types: types.map((t) => {
      const left = t.quantity === null ? partyLeft : Math.max(0, Math.min(partyLeft, t.quantity - t.held));
      return {
        id: t.id, name: t.name, description: t.description, price: t.price, currency: "EGP",
        places_left: left, sold_out: left === 0, on_sale: !!t.on_sale && left > 0,
        sales_opens_at: t.sales_opens_at, sales_closes_at: t.sales_closes_at,
        payment_instructions: t.payment_instructions ?? p.payment_instructions,
      };
    }),
    uploads: shotsOk(await uploadTarget(c.env, c.var.deps.now())),
    // What the form shows and the guest accepts; a request echoes these versions (src/guests/policy.ts).
    policy: await currentPolicy(c.env, p.rules),
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
  const typeField = form.get("type_id");
  const typeId = typeField === null || typeField === "" ? null : typeField;
  const answersText = form.get("answers");
  const file = form.get("screenshot");
  if (typeof token !== "string" || !parseToken(token) || !name || !email || !Number.isInteger(people) || people < 1 || people > 100
    || (typeId !== null && !isTypeId(typeId))) {
    return json(c, 400, { error: "invalid_request" });
  }
  // The Terms box is required here, not only in the page (a retry of a stored request sends it too).
  if (form.get("accept_terms") !== "yes") {
    return json(c, 400, { error: "terms_not_accepted", message: "Please accept the terms before submitting your request." });
  }
  const shown = shownPolicy(form);
  if (!shown) return json(c, 400, { error: "invalid_request" });
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
  const now = c.var.deps.now();
  const party = await gdb.signupParty(partyId, ticketId, { email, typeId, now });
  if (!party) return json(c, 404, { error: "not_found" });
  const env = envRecord(c);
  const done = async (status: number) => {
    await flushChangeLog(c.var.db, c.var.ledger, now, [ticketId]);
    const link = await signLink(env, { partyId, ticketId, version: 1 });
    // Duplicate warning: the address's other pending/approved requests for this party.
    const earlier = party.existing_party === null ? party.email_tickets : Math.max(0, party.email_tickets - 1);
    return json(c, status, { status: "requested", ticket_id: ticketId, link: linkPath(link), earlier_requests: earlier,
      ...(earlier > 0 ? { notice: `This email already has ${earlier} other request${earlier === 1 ? "" : "s"} for this party.` } : {}) });
  };
  // A retry of a sign-up that was already stored: finish its change log only.
  if (party.existing_party === partyId) return done(200);
  if (party.existing_party !== null) return json(c, 409, { error: "invalid_request" });
  // The guest accepted what the form showed; it must still be what applies now.
  const policy = await currentPolicy(c.env, party.rules);
  if (!samePolicy(shown, policy)) return termsChanged(c, party.rules, policy);

  const pf = storedForm(party.guest_form);
  const answers = checkAnswers(pf, answersRaw);
  if (!answers) return json(c, 400, { error: "invalid_answers" });
  if (people > party.max_people_per_ticket) return json(c, 400, { error: "too_many_people", max_people_per_ticket: party.max_people_per_ticket });
  if (pf.screenshot === "required" && !shot) return json(c, 400, { error: "screenshot_required" });
  if (pf.screenshot === "none" && shot) return json(c, 400, { error: "screenshot_not_wanted" });
  // Early answers (the insert below re-checks every rule in the same statement).
  const reg = registration(party, now);
  if (reg.state === "not_open_yet") return refusal(c, "registration_not_open");
  if (reg.state === "closed") return refusal(c, "registration_closed");
  if (party.max_tickets_per_email !== null && party.email_tickets >= party.max_tickets_per_email) return refusal(c, "email_limit");
  if (party.has_types && typeId === null) return refusal(c, "type_required");
  if (typeId !== null && !party.type_on_sale) return refusal(c, "type_unavailable");
  if (party.type_left !== null && party.type_left < people) return refusal(c, "type_full");
  if (party.held + people > party.capacity) return json(c, 409, { error: "full", message: REFUSAL.full.message });
  // Every files database past 70% (or unreadable): no new screenshots (fail closed; health alerts the owner).
  const target = shot ? await uploadTarget(c.env, now) : null;
  if (target && target.state !== "ok") {
    return json(c, 503, target.state === "full"
      ? { error: "uploads_full", message: "Screenshot uploads are paused for a moment. Please try again later." }
      : { error: "uploads_not_configured" });
  }
  // Per-party daily cap (src/limits/); a retry of a stored sign-up is not counted.
  const over = await chargeGuest(c, partyId, "signup");
  if (over) return over;

  let screenshotKey: string | null = null;
  if (shot) {
    screenshotKey = await FileStore.for(c.env, target!.writable!)!.put({
      id: fileId, partyId, ticketId, type: shot.type, bytes: shot.bytes, now,
    });
  }
  const r = await gdb.signup({
    id: ticketId, partyId, people, name, email, answers: Object.keys(answers).length ? JSON.stringify(answers) : null,
    screenshotKey, typeId, now, op: crypto.randomUUID(),
    rules: party.rules, accepted: { terms: policy.terms_version, rules: policy.rules_version, privacy: policy.privacy_version },
  });
  // The rules were edited between the read above and the insert: show the new ones.
  if (r === "terms_changed") {
    const fresh = await gdb.signupParty(partyId, ticketId);
    const rules = fresh ? fresh.rules : null;
    return termsChanged(c, rules, await currentPolicy(c.env, rules));
  }
  // A screenshot stored for a sign-up that was then refused stays as an orphan row
  // (no ticket points to it); it is never served (reads need the ticket).
  if (r !== "created" && r !== "already") return refusal(c, r);
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
  // Per-party daily cap, counted whether or not the address has a ticket (the answer must not tell).
  const over = await chargeGuest(c, partyId, "resend_link");
  if (over) return over;

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
      templates: await emailTemplates(c.var.db.driver, partyId),
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
  const party = await new PartyDb(c.var.db.driver).get(t.party_id);
  if (!party) return json(c, 404, { error: "invalid_link" });
  return json(c, 200, {
    // Only what this ticket may see: the place stays hidden until its address mode allows it.
    party: visiblePartyDetails(party, { kind: "ticket", status: t.status, released: t.released_at != null, onHold: t.hold_at != null }, c.var.deps.now()),
    ticket: {
      id: t.id,
      status: released ? "released" : t.status,
      guest_name: t.guest_name,
      people: t.people,
      type: t.type_name,
      // The door refuses this ticket before this time (its type's entry time), if set.
      entry_from: t.type_entry_from,
      group_note: groupNote(t.people),
      reject_reason: t.status === "rejected" ? t.reject_reason : null,
      on_hold: t.hold_at != null,
      used: t.used_at != null,
      qr: showQr ? await signQr(env, { partyId: t.party_id, ticketId: t.id, version: t.qr_version }) : null,
    },
  });
});
