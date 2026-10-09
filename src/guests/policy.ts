// What a guest accepts and is shown when asking for a ticket (Phase 5, owner
// request): Sahra's Terms, the party's entry rules when it has them, and the
// inline privacy notice. The server decides every version; the form only echoes
// the versions it displayed, and a mismatch means the guest saw something that is
// no longer current (409 terms_changed: review and tick the box again).
//
// - Terms: TERMS_VERSION, the "Last updated" date of public/terms.html (a test
//   keeps the two equal). Change it together with the page.
// - Privacy notice: PRIVACY_VERSION, the date of public/privacy.html, plus
//   "+email" when the notice includes the sentence about emails (shown only when
//   an email provider is configured, since only then is it true).
// - Party rules: "r-" and the first 16 hex digits of the SHA-256 of the entry
//   rules and the cancellation policy together; null when the party has
//   neither. The sign-up INSERT also compares both texts, so an edit between
//   this check and the insert refuses the request instead of recording an
//   acceptance of text the guest never saw.
//
// Accepting is not a promotional opt-in and does not cover any other use of the
// guest's details; nothing here is a legal basis for processing.

import { sha256hex } from "../lib/crypto";
import type { Env } from "../env";

export const TERMS_VERSION = "2026-10-09";
export const PRIVACY_VERSION = "2026-10-09";

/** True when ticket emails can actually be sent (the same settings src/email/sender.ts uses). */
export function emailConfigured(env: Pick<Env, "GMAIL_ADDRESS" | "GMAIL_APP_PASSWORD" | "BREVO_API_KEY" | "BREVO_SENDER">): boolean {
  return !!((env.GMAIL_ADDRESS && env.GMAIL_APP_PASSWORD) || (env.BREVO_API_KEY && env.BREVO_SENDER));
}

export async function rulesVersion(rules: string | null, cancellation: string | null = null): Promise<string | null> {
  const r = rules && rules.trim() ? rules : null, c = cancellation && cancellation.trim() ? cancellation : null;
  if (r === null && c === null) return null;
  return "r-" + (await sha256hex(`sahra-rules-v2|${JSON.stringify([r, c])}`)).slice(0, 16);
}

export type Policy = { terms_version: string; privacy_version: string; rules_version: string | null; email: boolean };

export async function currentPolicy(env: Parameters<typeof emailConfigured>[0], rules: string | null, cancellation: string | null): Promise<Policy> {
  const email = emailConfigured(env);
  return { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION + (email ? "+email" : ""), rules_version: await rulesVersion(rules, cancellation), email };
}

/** The versions a sign-up form says it displayed ("" for "no party rules"). */
export function shownPolicy(form: FormData): { terms: string; privacy: string; rules: string | null } | null {
  const terms = form.get("terms_version"), privacy = form.get("privacy_version"), rules = form.get("rules_version");
  if (typeof terms !== "string" || typeof privacy !== "string" || (rules !== null && typeof rules !== "string")) return null;
  if (terms.length > 40 || privacy.length > 40 || (rules ?? "").length > 40) return null;
  return { terms, privacy, rules: rules ? rules : null };
}

export function samePolicy(shown: { terms: string; privacy: string; rules: string | null }, now: Policy): boolean {
  return shown.terms === now.terms_version && shown.privacy === now.privacy_version && shown.rules === now.rules_version;
}
