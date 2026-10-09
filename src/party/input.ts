// Validation of a party details edit. Only the fields present in the request are
// changed; `null` clears an optional field. Unknown fields are refused so a typo
// cannot silently do nothing. Rules that depend on the stored row (capacity versus
// places held, the address lock, end after start, reveal time for at_time) are
// not checked here: they are in the UPDATE statement itself (src/party/db.ts).

import { ADDRESS_MODES, type AddressMode } from "./details";
import { isTimeZone, zonedToUtc } from "./time";

export const EDITABLE = [
  "name", "description", "starts_at", "ends_at", "time_zone", "venue_name", "address", "map_url", "rules", "cancellation_policy",
  "payment_instructions", "capacity", "max_people_per_ticket", "address_mode", "reveal_at", "address_locked_at",
  "email_ticket_subject", "email_ticket_body", "email_link_subject", "email_link_body",
  "registration_opens_at", "registration_closes_at", "max_tickets_per_email",
  "support_phone", "support_email", "support_note",
] as const;
export type EditableField = (typeof EDITABLE)[number];
export type EditValues = Partial<Record<EditableField, string | number | null>>;

/** Fields whose change counts as "the time or place changed" (may queue a notice to guests). */
export const TIME_OR_PLACE: readonly EditableField[] = ["starts_at", "ends_at", "time_zone", "venue_name", "address", "map_url"];
/** Fields frozen once address_locked_at has passed (the lock itself included). */
export const LOCKED: readonly EditableField[] = ["venue_name", "address", "map_url", "address_locked_at"];

const TIME_FIELDS = ["starts_at", "ends_at", "reveal_at", "address_locked_at", "registration_opens_at", "registration_closes_at"] as const;
const TEXT_LIMITS: Partial<Record<EditableField, number>> = {
  description: 2000, venue_name: 120, address: 300, rules: 2000, cancellation_policy: 2000, payment_instructions: 1000,
};
const MULTILINE = new Set<EditableField>(["description", "rules", "cancellation_policy", "payment_instructions", "address"]);
// 2020-01-01 .. 2100-01-01 UTC: anything else is a unit mistake (seconds, not ms).
export const MIN_T = 1577836800000;
export const MAX_T = 4102444800000;
export const MAX_CAPACITY = 100_000;
export const MAX_PEOPLE_PER_TICKET = 50;
export const MAX_TICKETS_PER_EMAIL = 100;

// Same ranges as src/outbox.ts assertPlainText (rule 6: no emojis), plus control characters.
const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

/**
 * A phone or WhatsApp number as typed: digits, spaces and + - ( ) only, 6 to 20
 * digits, a "+" only at the start. Spaces are tidied; nothing else is rewritten.
 */
export function cleanPhone(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/\s+/g, " ");
  if (!/^\+?[0-9 ()-]+$/.test(s)) return undefined;
  const digits = s.replace(/[^0-9]/g, "").length;
  return digits >= 6 && digits <= 20 && s.length <= 30 ? s : undefined;
}

/** A plain email address (lower case), or null to clear it. */
export function cleanContactEmail(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : undefined;
}

export function text(v: unknown, max: number, multiline: boolean): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  let s = v.replace(/\r\n?/g, "\n").trim();
  if (!multiline) s = s.replace(/\s+/g, " ");
  if (EMOJI.test(s) || /[\u0000-\u0008\u000B-\u001F\u007F]/.test(s)) return undefined;
  if (s.length > max) return undefined;
  return s === "" ? null : s;
}

/** https only, no user:password part, at most 500 characters. Returns the normalized URL. */
export function cleanMapUrl(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 500) return undefined;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return undefined;
  return u.href.length <= 500 ? u.href : undefined;
}

/** [field, max length, multi-line, allowed placeholders, required placeholder] */
export const EMAIL_FIELDS: readonly (readonly [EditableField, number, boolean, readonly string[], string | null])[] = [
  ["email_ticket_subject", 150, false, ["party_name", "guest_name"], null],
  ["email_ticket_body", 2000, true, ["guest_name", "party_name", "link", "people_note"], "link"],
  ["email_link_subject", 150, false, ["party_name"], null],
  ["email_link_body", 2000, true, ["party_name", "links"], "links"],
];

export type ParsedEdit = { ok: true; values: EditValues; notify: boolean } | { ok: false; error: string };

/**
 * Times are given either as `<field>` (UTC ms) or `<field>_local` ("YYYY-MM-DDTHH:MM"
 * in the party's zone; the request must then also carry `time_zone`).
 */
export function parseEdit(b: Record<string, unknown>): ParsedEdit {
  const allowed = new Set<string>([...EDITABLE, ...TIME_FIELDS.map((f) => `${f}_local`), "notify_guests"]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) return { ok: false, error: `unknown_field:${k}` };
  const values: EditValues = {};
  const bad = (f: string): ParsedEdit => ({ ok: false, error: `invalid_field:${f}` });

  if ("name" in b) {
    const s = text(b.name, 80, false);
    if (!s) return bad("name");
    values.name = s;
  }
  for (const f of ["description", "venue_name", "address", "rules", "cancellation_policy", "payment_instructions"] as const) {
    if (!(f in b)) continue;
    const s = text(b[f], TEXT_LIMITS[f]!, MULTILINE.has(f));
    if (s === undefined) return bad(f);
    values[f] = s;
  }
  if ("support_phone" in b) {
    const ph = cleanPhone(b.support_phone);
    if (ph === undefined) return bad("support_phone");
    values.support_phone = ph;
  }
  if ("support_email" in b) {
    const em = cleanContactEmail(b.support_email);
    if (em === undefined) return bad("support_email");
    values.support_email = em;
  }
  if ("support_note" in b) {
    const n = text(b.support_note, 120, false);
    if (n === undefined) return bad("support_note");
    values.support_note = n;
  }
  if ("map_url" in b) {
    const u = cleanMapUrl(b.map_url);
    if (u === undefined) return bad("map_url");
    values.map_url = u;
  }
  if ("time_zone" in b) {
    if (b.time_zone !== null && !isTimeZone(b.time_zone)) return bad("time_zone");
    values.time_zone = b.time_zone as string | null;
  }
  for (const f of TIME_FIELDS) {
    const local = `${f}_local`;
    if (f in b && local in b) return bad(f);
    if (f in b) {
      const v = b[f];
      if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < MIN_T || v > MAX_T)) return bad(f);
      values[f] = v as number | null;
    } else if (local in b) {
      if (b[local] === null) {
        values[f] = null;
        continue;
      }
      if (!isTimeZone(b.time_zone)) return { ok: false, error: "time_zone_required_for_local_times" };
      const t = zonedToUtc(b[local], b.time_zone);
      if (t === null || t < MIN_T || t > MAX_T) return bad(local);
      values[f] = t;
    }
  }
  if ("address_mode" in b) {
    if (!(ADDRESS_MODES as readonly unknown[]).includes(b.address_mode)) return bad("address_mode");
    values.address_mode = b.address_mode as AddressMode;
  }
  if ("capacity" in b) {
    const v = b.capacity;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_CAPACITY) return bad("capacity");
    values.capacity = v;
  }
  if ("max_people_per_ticket" in b) {
    const v = b.max_people_per_ticket;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_PEOPLE_PER_TICKET) return bad("max_people_per_ticket");
    values.max_people_per_ticket = v;
  }
  // Pending + approved tickets per guest email; null = no limit.
  if ("max_tickets_per_email" in b) {
    const v = b.max_tickets_per_email;
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_TICKETS_PER_EMAIL)) return bad("max_tickets_per_email");
    values.max_tickets_per_email = v as number | null;
  }
  // Owner-editable guest emails (src/guests/emails.ts). Only the listed
  // placeholders; the body must contain the guest's link, so a custom text can
  // never leave a guest without their ticket.
  for (const [f, max, multiline, allowed, required] of EMAIL_FIELDS) {
    if (!(f in b)) continue;
    const s = text(b[f], max, multiline);
    if (s === undefined) return bad(f);
    if (s !== null) {
      const names = [...s.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
      if (names.some((n) => !allowed.includes(n)) || (required && !names.includes(required))) return bad(f);
    }
    values[f] = s;
  }
  if ("notify_guests" in b && typeof b.notify_guests !== "boolean") return bad("notify_guests");
  if (Object.keys(values).length === 0) return { ok: false, error: "nothing_to_change" };
  return { ok: true, values, notify: b.notify_guests === true };
}
