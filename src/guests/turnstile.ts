// Cloudflare Turnstile (bot check) for the two unauthenticated guest writes:
// sign-up and "resend my ticket link". Verified server-side (siteverify) BEFORE any
// database access. Fails closed: no secret, a test secret outside test/staging, an
// unreachable siteverify or any answer other than success means no write.

import type { Fetcher } from "../auth/google";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare's documented test secrets (always pass / always fail / already spent).
// Accepted only where test tickets are enabled (tests, staging), never in production.
const TEST_SECRET = /^[123]x0{31}AA$/;

export type TurnstileResult = "ok" | "failed" | "not_configured" | "unavailable";

export function turnstileConfigured(env: { TURNSTILE_SECRET?: string; TURNSTILE_SITE_KEY?: string; ENABLE_TEST_TICKETS?: string }): boolean {
  const s = env.TURNSTILE_SECRET;
  if (!s || !env.TURNSTILE_SITE_KEY) return false;
  if (TEST_SECRET.test(s) && env.ENABLE_TEST_TICKETS !== "1") return false;
  return true;
}

export async function verifyTurnstile(
  fetcher: Fetcher,
  env: { TURNSTILE_SECRET?: string; TURNSTILE_SITE_KEY?: string; ENABLE_TEST_TICKETS?: string },
  token: unknown,
  ip: string,
): Promise<TurnstileResult> {
  if (!turnstileConfigured(env)) return "not_configured";
  // Turnstile tokens are at most 2048 characters (Cloudflare docs).
  if (typeof token !== "string" || token.length < 1 || token.length > 2048) return "failed";
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: token });
  if (ip !== "unknown") form.set("remoteip", ip);
  let body: { success?: unknown };
  try {
    const r = await fetcher(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!r.ok) return "unavailable";
    body = (await r.json()) as { success?: unknown };
  } catch {
    return "unavailable";
  }
  return body.success === true ? "ok" : "failed";
}
