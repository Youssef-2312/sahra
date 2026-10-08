// A party's sign-up form (parties.guest_form, JSON) and validation of a guest's
// answers against it. Everything here is pure (no database).
//
//   { "questions": [ { "id": "instagram", "label": "Instagram handle", "type": "text", "required": true },
//                    { "id": "size", "label": "T-shirt size", "type": "choice", "options": ["S", "M", "L"], "required": false } ],
//     "screenshot": "required" | "optional" | "none" }
//
// A party without a form asks only name, email and people, and requires a payment
// screenshot.

export interface Question {
  id: string;
  label: string;
  type: "text" | "choice";
  required: boolean;
  options?: string[];
}

export interface GuestForm {
  questions: Question[];
  screenshot: "required" | "optional" | "none";
}

export const DEFAULT_FORM: GuestForm = { questions: [], screenshot: "required" };

const MAX_QUESTIONS = 20;
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
  if (screenshot !== "required" && screenshot !== "optional" && screenshot !== "none") return null;
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
    if (!label || (r.type !== "text" && r.type !== "choice")) return null;
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
  return { questions: out, screenshot };
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
  const out: Record<string, string> = {};
  for (const q of form.questions) {
    const raw = g[q.id];
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
