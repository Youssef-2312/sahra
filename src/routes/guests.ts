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

import { formatHuman } from "../party/time";
import { Hono } from "hono/tiny";
import { flushChangeLog } from "../changelog";
import { json, readJson, type AppEnv, type Ctx } from "../context";
import { D1Driver } from "../db/driver";
import { sql } from "../db/sql";
import { GuestDb, type SignupParty, type SignupRefusal } from "../guests/db";
import { emailTemplates, findEmail, groupNote, linkEmail } from "../guests/emails";
import { checkAnswers, cleanInstagram, MAX_PHOTO_QUESTIONS, PHOTO_ANSWER, storedForm } from "../guests/form";
import { currentPolicy, samePolicy, shownPolicy, type Policy } from "../guests/policy";
import { linkPath, signLink, verifyLink } from "../guests/link";
import { referenceOf } from "../guests/reference";
import { turnstileConfigured, verifyTurnstile } from "../guests/turnstile";
import { isTypeId, TypeDb } from "../guests/types";
import { base32, parseToken, sha256, sha256hex } from "../lib/crypto";
import { clientIp, rateLimited, sameOrigin } from "../lib/http";
import { charge, chargeGuest, limited } from "../limits";
import { PartyDb } from "../party/db";
import { visiblePartyDetails } from "../party/details";
import { FlyerDb, flyerUrl, isFlyerId } from "../party/flyers";
import { getFlyerFile } from "../storage";
import { signQr } from "../qr";
import { answerPhotoOwner, FileStore, idPhotoOwner, MAX_FILE_BYTES, sniffImage, uploadTarget, type FilesCapacity } from "../storage";

export const guestRoutes = new Hono<AppEnv>();

const PARTY_RE = /^[a-z0-9-]{3,24}$/;
/** The whole multipart request: the screenshot plus room for the other fields. */
/** Separate tickets in one request (each its own QR code; migrations/0022). */
export const MAX_ORDER_TICKETS = 10;
// A payment screenshot and an ID photo, plus the form fields.
// The proof of payment, one ID photo per ticket of the largest order and the picture answers, plus the text fields.
const MAX_SIGNUP_BYTES = (1 + MAX_ORDER_TICKETS + MAX_PHOTO_QUESTIONS) * MAX_FILE_BYTES + 64 * 1024;
const MAX_ANSWERS_JSON = 16 * 1024;
/** One "resend my link" email per address per party per window (see GuestDb.addLinkEmail). */
const LINK_EMAIL_WINDOW_MS = 10 * 60_000;
/** "Find my tickets": at most one email per address per hour. */
const FIND_EMAIL_WINDOW_MS = 60 * 60_000;

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
  // The ID photo's file id: from a second hash, so it never equals the screenshot's.
  const h2 = await sha256(`sahra-idphoto-v1|${partyId}|${token}`);
  let m = 0;
  for (const b of h2.subarray(0, 6)) m = m * 256 + b;
  return { ticketId: base32(h.subarray(0, 10), 16), fileId: n + 1, idFileId: m + 1 };
}
/** The file id of the ID photo of an order's i-th other ticket (1, 2...): from the same token, so a retry is the same file. */
async function friendIdFileId(partyId: string, token: string, i: number) {
  const h = await sha256(`sahra-idphoto-v1|${partyId}|${token}|${i}`);
  let m = 0;
  for (const b of h.subarray(0, 6)) m = m * 256 + b;
  return m + 1;
}
/** The file id of the picture answering question `qid`: from the same token, so a retry is the same file. */
async function answerPhotoFileId(partyId: string, token: string, qid: string) {
  const h = await sha256(`sahra-answerphoto-v1|${partyId}|${token}|${qid}`);
  let m = 0;
  for (const b of h.subarray(0, 6)) m = m * 256 + b;
  return m + 1;
}
/** The other tickets of an order (2nd, 3rd...): ids from the same token, so a retry is the same order. */
async function orderIds(partyId: string, token: string, count: number) {
  const out: string[] = [];
  for (let i = 1; i < count; i++) out.push(base32((await sha256(`sahra-signup-v1|${partyId}|${token}|${i}`)).subarray(0, 10), 16));
  return out;
}

const shotsOk = (cap: FilesCapacity) => cap.state === "ok";

/** Registration state at `now` (party rules, migrations/0014). */
function registration(p: Pick<SignupParty, "registration_opens_at" | "registration_closes_at" | "support_phone" | "cancelled_at">, now: number) {
  // Requests open only once the organiser has set a support number (brainstorm idea 16).
  const needsContact = !p.support_phone;
  const notYet = needsContact || (p.registration_opens_at !== null && p.registration_opens_at > now);
  const over = !!p.cancelled_at || (p.registration_closes_at !== null && p.registration_closes_at <= now);
  return { opens_at: needsContact ? null : p.registration_opens_at, closes_at: p.registration_closes_at, open: !p.cancelled_at && !notYet && !over,
    state: p.cancelled_at ? "closed" : notYet ? "not_open_yet" : over ? "closed" : "open", needs_contact: needsContact && !p.cancelled_at,
    cancelled: !!p.cancelled_at } as const;
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
  people_out_of_range: { status: 400, message: "This number of people is not allowed for this ticket." },
  form_changed: { status: 409, message: "The guest form has changed. Reload and review your answers." },
  terms_changed: { status: 409, message: "The terms or this party's rules have changed. Please review them before sending your request." },
  refused: { status: 409, message: "This request cannot be made." },
};

function refusal(c: Ctx, why: SignupRefusal) {
  const r = REFUSAL[why];
  return json(c, r.status, { error: why === "refused" ? "not_allowed" : why, message: r.message });
}

/** The form showed older terms, rules or notice: nothing stored; the current ones, to show and accept again. */
function termsChanged(c: Ctx, p: { rules: string | null; cancellation_policy: string | null }, policy: Policy) {
  return json(c, 409, { error: "terms_changed", message: REFUSAL.terms_changed.message, policy, rules: p.rules, cancellation_policy: p.cancellation_policy });
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
      const notYet = !p.support_phone || (p.registration_opens_at !== null && p.registration_opens_at > now);
      const over = p.registration_closes_at !== null && p.registration_closes_at <= now;
      const left = Math.max(0, p.capacity - p.held);
      return {
        id: p.id, name: p.name, starts_at: p.starts_at, ends_at: p.ends_at, time_zone: p.time_zone,
        from_price: p.from_price, price_count: p.price_count, places_left: left,
        flyers: p.flyers.map((f) => ({ id: f.id, url: flyerUrl(p.id, f.id, f.rev) })),
        state: p.cancelled_at ? "cancelled" : left === 0 ? "full" : notYet ? "not_open_yet" : over ? "closed" : "open",
        opens_at: notYet && p.support_phone ? p.registration_opens_at : null,
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
    // Prices are whole Egyptian pounds, per person, or for the whole ticket when `package` (a type of one
    // fixed group size, src/guests/types.ts isPackage). A request must name one of these when the list is not empty.
    types: types.map((t) => {
      const left = t.quantity === null ? partyLeft : Math.max(0, Math.min(partyLeft, t.quantity - t.held));
      return {
        id: t.id, name: t.name, description: t.description, price: t.price, currency: "EGP",
        // People one ticket of this type admits (a group type, a single one).
        min_people: t.min_people ?? 1, max_people: t.max_people ?? p.max_people_per_ticket,
        package: t.min_people !== null && t.min_people > 1 && t.min_people === t.max_people,
        places_left: left, sold_out: left === 0, on_sale: !!t.on_sale && left > 0,
        sales_opens_at: t.sales_opens_at, sales_closes_at: t.sales_closes_at,
        payment_instructions: t.payment_instructions ?? p.payment_instructions,
      };
    }),
    uploads: shotsOk(await uploadTarget(c.env, c.var.deps.now())),
    // What the form shows and the guest accepts; a request echoes these versions (src/guests/policy.ts).
    policy: await currentPolicy(c.env, p.rules, p.cancellation_policy, form.id_photo !== "none"),
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
  // Separate tickets for friends: how many, and (optionally) the name on each of the others.
  const count = Number(form.get("tickets") ?? 1);
  const namesText = form.get("names");
  const typeField = form.get("type_id");
  const typeId = typeField === null || typeField === "" ? null : typeField;
  const answersText = form.get("answers");
  const file = form.get("screenshot");
  if (typeof token !== "string" || !parseToken(token) || !name || !email || !Number.isInteger(people) || people < 1 || people > 100
    || (typeId !== null && !isTypeId(typeId)) || !Number.isInteger(count) || count < 1 || count > MAX_ORDER_TICKETS) {
    return json(c, 400, { error: "invalid_request" });
  }
  // Names on the other tickets: optional; an empty one takes the guest's own name.
  const otherNames: string[] = [];
  if (namesText !== null) {
    let raw: unknown;
    try { raw = typeof namesText === "string" && namesText.length <= 4096 ? JSON.parse(namesText) : null; } catch { raw = null; }
    if (!Array.isArray(raw) || raw.length > count - 1) return json(c, 400, { error: "invalid_request" });
    for (const v of raw) {
      if (v === null || (typeof v === "string" && v.trim() === "")) { otherNames.push(name); continue; }
      const n2 = guestName(v);
      if (!n2) return json(c, 400, { error: "invalid_request" });
      otherNames.push(n2);
    }
  }
  while (otherNames.length < count - 1) otherNames.push(name);
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
  type Image = { bytes: Uint8Array; type: NonNullable<ReturnType<typeof sniffImage>> };
  const image = async (v: File | string | null, what: "screenshot" | "id_photo" | "photo"): Promise<Image | null | Response> => {
    if (v === null) return null;
    if (typeof v === "string") return json(c, 400, { error: "invalid_request" });
    if (v.size > MAX_FILE_BYTES) return json(c, 413, { error: "too_large", max_screenshot_bytes: MAX_FILE_BYTES });
    const bytes = new Uint8Array(await v.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type || bytes.length === 0) return json(c, 415, { error: `${what}_must_be_jpeg_png_or_webp` });
    return { bytes, type };
  };
  const shotOr = await image(file, "screenshot");
  if (shotOr instanceof Response) return shotOr;
  const idOr = await image(form.get("id_photo"), "id_photo");
  if (idOr instanceof Response) return idOr;
  const shot = shotOr, idPhoto = idOr;
  // One ID photo per friend's ticket of an order ("id_photo_1", "id_photo_2"...), when the party asks for ID.
  const friendIds: (Image | null)[] = [];
  for (let i = 1; i < MAX_ORDER_TICKETS; i++) {
    const f = await image(form.get(`id_photo_${i}`), "id_photo");
    if (f instanceof Response) return f;
    friendIds.push(f);
  }
  // Pictures answering "photo" questions: field q_<question id>, checked against the form below.
  const answerPhotos = new Map<string, Image>();
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("q_")) continue;
    const qid = k.slice(2);
    if (!/^[a-z0-9_]{1,32}$/.test(qid) || answerPhotos.has(qid) || answerPhotos.size >= MAX_PHOTO_QUESTIONS) return json(c, 400, { error: "invalid_request" });
    const f = await image(v, "photo");
    if (f instanceof Response) return f;
    if (f) answerPhotos.set(qid, f);
  }
  // The Instagram handle as typed ("@name", a profile link...), reduced to the handle.
  const instaField = form.get("instagram");
  const instaGiven = typeof instaField === "string" && instaField.trim() !== "";
  const instagram = instaGiven ? cleanInstagram(instaField) : null;
  if (instaGiven && !instagram) return json(c, 400, { error: "invalid_instagram" });
  // Fail closed: without the files database a screenshot or ID photo cannot be kept.
  const anyFriendId = friendIds.some((x) => x !== null);
  if ((shot || idPhoto || anyFriendId || answerPhotos.size) && !c.env.FILES) return json(c, 503, { error: "uploads_not_configured" });

  const bot = await verifyTurnstile(c.var.deps.fetch, c.env, form.get("cf-turnstile-response"), ip);
  if (bot !== "ok") return turnstileAnswer(c, bot);

  const gdb = new GuestDb(c.var.db.driver);
  const { ticketId, fileId, idFileId } = await signupIds(partyId, token);
  const now = c.var.deps.now();
  const party = await gdb.signupParty(partyId, ticketId, { email, typeId, now });
  if (!party) return json(c, 404, { error: "not_found" });
  const env = envRecord(c);
  const done = async (status: number) => {
    // Every ticket of the order (a retry finds them by the first ticket's id).
    // In the order the guest listed them (the ids follow the ticket number; created_at is the same for all).
    const found = await gdb.orderTickets(partyId, ticketId);
    const pos = new Map([ticketId, ...(await orderIds(partyId, token, found.length))].map((id, i) => [id, i]));
    const order = [...found].sort((a, b) => (pos.get(a.id) ?? found.length) - (pos.get(b.id) ?? found.length));
    await flushChangeLog(c.var.db, c.var.ledger, now, order.map((t) => t.id));
    const tickets = await Promise.all(order.map(async (t) => ({
      ticket_id: t.id, reference: referenceOf(t.id), name: t.guest_name, link: linkPath(await signLink(env, { partyId, ticketId: t.id, version: 1 })),
    })));
    // Duplicate warning: the address's other pending/approved requests for this party.
    const earlier = party.existing_party === null ? party.email_tickets : Math.max(0, party.email_tickets - order.length);
    return json(c, status, { status: "requested", ticket_id: ticketId, reference: referenceOf(ticketId), link: tickets[0]!.link, tickets, earlier_requests: earlier,
      ...(earlier > 0 ? { notice: `This email already has ${earlier} other request${earlier === 1 ? "" : "s"} for this party.` } : {}) });
  };
  // A retry of a sign-up that was already stored: finish its change log only.
  if (party.existing_party === partyId) return done(200);
  if (party.existing_party !== null) return json(c, 409, { error: "invalid_request" });
  // The guest accepted what the form showed; it must still be what applies now.
  const policy = await currentPolicy(c.env, party.rules, party.cancellation_policy, storedForm(party.guest_form).id_photo !== "none");
  if (!samePolicy(shown, policy)) return termsChanged(c, party, policy);

  const pf = storedForm(party.guest_form);
  const answers = checkAnswers(pf, answersRaw);
  if (!answers) return json(c, 400, { error: "invalid_answers" });
  // Each picture must answer one of the form's picture questions; required ones must have one.
  const photoQs = pf.questions.filter((q) => q.type === "photo");
  for (const qid of answerPhotos.keys()) if (!photoQs.some((q) => q.id === qid)) return json(c, 400, { error: "invalid_answers" });
  const missingPhoto = photoQs.find((q) => q.required && !answerPhotos.has(q.id));
  if (missingPhoto) return json(c, 400, { error: "photo_required", question: missingPhoto.id });
  // People per ticket: the chosen type's own limits (a group ticket, a single one), else the party's.
  if (people > party.max_people) return json(c, 400, { error: "too_many_people", max_people_per_ticket: party.max_people });
  if (people < party.min_people) return json(c, 400, { error: "too_few_people", min_people: party.min_people });
  if (pf.screenshot === "required" && !shot) return json(c, 400, { error: "screenshot_required" });
  if (pf.screenshot === "none" && shot) return json(c, 400, { error: "screenshot_not_wanted" });
  if (pf.id_photo === "required" && !idPhoto) return json(c, 400, { error: "id_photo_required" });
  if (pf.id_photo === "none" && (idPhoto || anyFriendId)) return json(c, 400, { error: "id_photo_not_wanted" });
  // Every friend's ticket needs its own ID photo when the party requires one; none beyond the order's tickets.
  if (friendIds.slice(count - 1).some((x) => x !== null)) return json(c, 400, { error: "invalid_request" });
  if (pf.id_photo === "required") {
    const missing = friendIds.slice(0, count - 1).findIndex((x) => x === null);
    if (missing >= 0) return json(c, 400, { error: "id_photo_required", ticket: missing + 2 });
  }
  if (pf.instagram === "required" && !instagram) return json(c, 400, { error: "instagram_required" });
  // Early answers (the insert below re-checks every rule in the same statement).
  const reg = registration(party, now);
  if (reg.state === "not_open_yet") return refusal(c, "registration_not_open");
  if (reg.state === "closed") return refusal(c, "registration_closed");
  if (party.max_tickets_per_email !== null && party.email_tickets + count > party.max_tickets_per_email) return refusal(c, "email_limit");
  if (party.has_types && typeId === null) return refusal(c, "type_required");
  if (typeId !== null && !party.type_on_sale) return refusal(c, "type_unavailable");
  if (party.type_left !== null && party.type_left < people * count) return refusal(c, "type_full");
  if (party.held + people * count > party.capacity) return json(c, 409, { error: "full", message: REFUSAL.full.message });
  // Every files database past 70% (or unreadable): no new screenshots (fail closed; health alerts the owner).
  const target = shot || idPhoto || anyFriendId || answerPhotos.size ? await uploadTarget(c.env, now) : null;
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
  let idPhotoKey: string | null = null;
  if (idPhoto) {
    idPhotoKey = await FileStore.for(c.env, target!.writable!)!.put({
      id: idFileId, partyId, ticketId: idPhotoOwner(ticketId), type: idPhoto.type, bytes: idPhoto.bytes, now,
    });
  }
  // Picture answers are kept on the first ticket, as the other answers; the answer holds the file key.
  for (const [qid, f] of answerPhotos) {
    const key = await FileStore.for(c.env, target!.writable!)!.put({
      id: await answerPhotoFileId(partyId, token, qid), partyId, ticketId: answerPhotoOwner(ticketId, qid), type: f.type, bytes: f.bytes, now,
    });
    answers[qid] = PHOTO_ANSWER + key;
  }
  const others = await orderIds(partyId, token, count);
  const friendKeys: (string | null)[] = [];
  for (let i = 0; i < others.length; i++) {
    const f = friendIds[i];
    friendKeys.push(f ? await FileStore.for(c.env, target!.writable!)!.put({
      id: await friendIdFileId(partyId, token, i + 1), partyId, ticketId: idPhotoOwner(others[i]!), type: f.type, bytes: f.bytes, now,
    }) : null);
  }
  const r = await gdb.signup({
    id: ticketId, partyId, people, name, email, answers: Object.keys(answers).length ? JSON.stringify(answers) : null,
    screenshotKey, idPhotoKey, instagram: pf.instagram === "none" ? null : instagram, typeId, now, op: crypto.randomUUID(),
    more: others.map((id, i) => ({ id, name: otherNames[i]!, idPhotoKey: friendKeys[i] ?? null })),
    guestForm: party.guest_form, rules: party.rules, cancellation: party.cancellation_policy, accepted: { terms: policy.terms_version, rules: policy.rules_version, privacy: policy.privacy_version },
  });
  // The rules were edited between the read above and the insert: show the new ones.
  if (r === "terms_changed") {
    const fresh = (await gdb.signupParty(partyId, ticketId)) ?? { rules: null, cancellation_policy: null };
    return termsChanged(c, fresh, await currentPolicy(c.env, fresh.rules, fresh.cancellation_policy, pf.id_photo !== "none"));
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
 * "Find my tickets" (brainstorm idea 4, owner decision): on another device, a
 * guest types their email and gets ONE email with the links to all their tickets
 * across parties. No accounts. The answer is the same whether or not the address
 * has tickets; rate limited per IP and per address, at most one email per address
 * per hour (checked by the outbox id), and a site-wide daily cap counted whether
 * or not anything is sent. The email is filed under the soonest party, so it is
 * erased with that party's guest details (src/guests/retention.ts).
 */
guestRoutes.get("/find", (c) => json(c, 200, { turnstile_site_key: turnstileConfigured(c.env) ? c.env.TURNSTILE_SITE_KEY : null }));

guestRoutes.post("/find", async (c) => {
  if (!sameOrigin(c, c.env.PUBLIC_ORIGIN)) return json(c, 403, { error: "bad_origin" });
  const ip = clientIp(c);
  if (await rateLimited(c.env.RL_AUTH, `find:${ip}`)) return json(c, 429, { error: "rate_limited" });
  const b = await readJson(c);
  const email = guestEmail(b?.email);
  if (!email) return json(c, 400, { error: "invalid_request" });
  if (await rateLimited(c.env.RL_AUTH, `find-email:${await sha256hex(email)}`)) return json(c, 429, { error: "rate_limited" });
  const bot = await verifyTurnstile(c.var.deps.fetch, c.env, b?.turnstile, ip);
  if (bot !== "ok") return turnstileAnswer(c, bot);
  const now = c.var.deps.now();
  const counted = await charge(c.var.db.driver, "_platform", "find_tickets", 1, now);
  if (counted !== "ok") return limited(c, "find_tickets", counted);

  const gdb = new GuestDb(c.var.db.driver);
  const tickets = await gdb.ticketsAcrossParties(email, now);
  if (tickets.length > 0) {
    const env = envRecord(c);
    const items = [];
    for (const t of tickets) {
      items.push({ partyName: t.party_name, when: t.starts_at === null ? null : dateIn(t.starts_at, t.time_zone),
        link: await signLink(env, { partyId: t.party_id, ticketId: t.id, version: t.link_version }) });
    }
    const id = `find-${(await sha256hex(`${email}|${Math.floor(now / FIND_EMAIL_WINDOW_MS)}`)).slice(0, 32)}`;
    await gdb.addFindEmail(findEmail({ id, origin: c.env.PUBLIC_ORIGIN, partyId: tickets[0]!.party_id, to: email, now, items }));
  }
  return json(c, 200, { status: "ok", message: "If this address has tickets, an email with their links is on the way." });
});

/** "Sat 31/10/2026, 22:00" in the party's time zone (English: the email is in English; owner: DD/MM/YYYY). */
function dateIn(ms: number, tz: string | null): string {
  try {
    return formatHuman(ms, tz ?? "Africa/Cairo").replace(/ \([^)]*\)$/, "");
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
}

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
  // A refund the organiser recorded for this ticket (migrations/0026); read only for a cancelled party or a cancelled ticket.
  const refund = party.cancelled_at || t.status === "cancelled"
    ? (await c.var.db.driver.all<{ state: string; amount: number }>(sql`SELECT state, amount FROM refunds WHERE ticket_id = ${t.id} AND party_id = ${t.party_id}`)).results[0] ?? null
    : null;
  return json(c, 200, {
    // Only what this ticket may see: the place stays hidden until its address mode allows it.
    party: visiblePartyDetails(party, { kind: "ticket", status: t.status, released: t.released_at != null, onHold: t.hold_at != null }, c.var.deps.now()),
    ticket: {
      id: t.id,
      reference: referenceOf(t.id),
      refund: refund ? { state: refund.state, amount: refund.amount } : null,
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
