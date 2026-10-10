// A party's sign-up form (parties.guest_form, JSON) and validation of a guest's
// answers against it. Everything here is pure (no database).
//
//   { "questions": [ { "id": "instagram", "label": "Instagram handle", "type": "text", "required": true },
//                    { "id": "size", "label": "T-shirt size", "type": "choice", "options": ["S", "M", "L"], "required": false },
//                    { "id": "costume", "label": "A picture of your costume", "type": "photo", "required": false } ],
//     "screenshot": "required" | "optional" | "none",
//     "id_photo": "required" | "optional" | "none",      (default "none")
//     "instagram": "required" | "optional" | "none" }    (default "none")
//
// A party without a form asks only name, email and people, and requires a payment
// screenshot. The ID photo and Instagram handle are their own fields (stored on the
// ticket, migrations/0020), not questions. A "photo" question is answered with an
// uploaded picture (sign-up field q_<id>), stored like an ID photo; the answer keeps
// "photo:<file key>" (src/routes/guests.ts), shown to staff as a picture.

export interface Question {
  id: string;
  label: string;
  type: "text" | "choice" | "photo";
  required: boolean;
  options?: string[];
}

export type Ask = "required" | "optional" | "none";
export interface GuestForm {
  questions: Question[];
  screenshot: Ask;
  id_photo: Ask;
  instagram: Ask;
}

export const DEFAULT_FORM: GuestForm = { questions: [], screenshot: "required", id_photo: "none", instagram: "none" };
const isAsk = (v: unknown): v is Ask => v === "required" || v === "optional" || v === "none";

/**
 * An Instagram handle as the guest typed it ("@name", "name" or a profile link),
 * reduced to the handle: lower case, 1-30 letters, digits, dots and underscores,
 * not starting or ending with a dot and without two dots in a row. null if it is not one.
 */
export function cleanInstagram(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().toLowerCase();
  const link = /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(s);
  if (link) s = link[1]!;
  s = s.replace(/^@/, "");
  if (!/^[a-z0-9._]{1,30}$/.test(s) || s.startsWith(".") || s.endsWith(".") || s.includes("..")) return null;
  return s;
}

const MAX_QUESTIONS = 20;
/** Picture questions per form (each one more upload in a sign-up). */
export const MAX_PHOTO_QUESTIONS = 3;
/** How a picture answer is kept in a ticket's answers: "photo:" + the file key. */
export const PHOTO_ANSWER = "photo:";
const MAX_LABEL = 200;
const MAX_OPTIONS = 20;
const MAX_OPTION = 100;
export const MAX_ANSWER = 500;

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s.length >= 1 && s.length <= max ? s : null;
}

/** Validates a form sent by an owner/admin; returns the normalized form or null. */
export function parseForm(v: unknown): GuestForm | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const screenshot = o.screenshot ?? "required";
  const idPhoto = o.id_photo ?? "none";
  const instagram = o.instagram ?? "none";
  if (!isAsk(screenshot) || !isAsk(idPhoto) || !isAsk(instagram)) return null;
  const qs = o.questions ?? [];
  if (!Array.isArray(qs) || qs.length > MAX_QUESTIONS) return null;
  const out: Question[] = [];
  const ids = new Set<string>();
  for (const q of qs) {
    if (typeof q !== "object" || q === null) return null;
    const r = q as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[a-z0-9_]{1,32}$/.test(r.id) || ids.has(r.id)) return null;
    ids.add(r.id);
    const label = cleanText(r.label, MAX_LABEL);
    if (!label || (r.type !== "text" && r.type !== "choice" && r.type !== "photo")) return null;
    if (r.required !== undefined && typeof r.required !== "boolean") return null;
    const question: Question = { id: r.id, label, type: r.type, required: r.required === true };
    if (r.type === "choice") {
      if (!Array.isArray(r.options) || r.options.length < 1 || r.options.length > MAX_OPTIONS) return null;
      const opts = r.options.map((x) => cleanText(x, MAX_OPTION));
      if (opts.some((x) => x === null) || new Set(opts).size !== opts.length) return null;
      question.options = opts as string[];
    } else if (r.options !== undefined) {
      return null;
    }
    out.push(question);
  }
  if (out.filter((q) => q.type === "photo").length > MAX_PHOTO_QUESTIONS) return null;
  return { questions: out, screenshot, id_photo: idPhoto, instagram };
}

/** The stored form (written only through parseForm), or the default. */
export function storedForm(text: unknown): GuestForm {
  if (typeof text !== "string") return DEFAULT_FORM;
  try {
    return parseForm(JSON.parse(text)) ?? DEFAULT_FORM;
  } catch {
    return DEFAULT_FORM;
  }
}

/**
 * Checks a guest's answers: an object of question id -> string. Unknown ids,
 * missing required answers, over-long text and choices not on the list are
 * refused. Returns the answers to store (only non-empty ones) or null.
 */
export function checkAnswers(form: GuestForm, v: unknown): Record<string, string> | null {
  const given = v === undefined || v === null ? {} : v;
  if (typeof given !== "object" || Array.isArray(given)) return null;
  const g = given as Record<string, unknown>;
  const known = new Set(form.questions.map((q) => q.id));
  for (const k of Object.keys(g)) if (!known.has(k)) return null;
  const out: Record<string, string> = Object.create(null);
  for (const q of form.questions) {
    const raw = g[q.id];
    // Picture answers come as files (checked by the sign-up route), never as text.
    if (q.type === "photo") {
      if (raw !== undefined && raw !== null && raw !== "") return null;
      continue;
    }
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
      if (q.required) return null;
      continue;
    }
    const s = cleanText(raw, MAX_ANSWER);
    if (!s) return null;
    if (q.type === "choice" && !q.options!.includes(s)) return null;
    out[q.id] = s;
  }
  return out;
}
