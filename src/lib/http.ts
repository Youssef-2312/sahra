import type { Context } from "hono";

export const COOKIE_SESSION = "__Host-sahra_s";
export const COOKIE_LOGIN = "__Host-sahra_login";
export const COOKIE_PICK = "__Host-sahra_pick";

export function cookie(
  name: string,
  value: string,
  opts: { maxAgeS: number; sameSite: "Strict" | "Lax" },
): string {
  // __Host- prefix: requires Secure, Path=/ and no Domain, so no subdomain can set or read it.
  return `${name}=${value}; Max-Age=${opts.maxAgeS}; Path=/; HttpOnly; Secure; SameSite=${opts.sameSite}`;
}

export function clearCookie(name: string, sameSite: "Strict" | "Lax" = "Strict"): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=${sameSite}`;
}

export function readCookie(c: Context, name: string): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * State-changing requests must come from our own pages: the browser-set Origin
 * header must equal our public origin. Requests without Origin are refused.
 */
export function sameOrigin(c: Context, publicOrigin: string): boolean {
  const origin = c.req.header("origin");
  if (!origin || origin !== publicOrigin) return false;
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  return true;
}

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

/**
 * Workers Rate Limiting binding. It is per Cloudflare location and eventually
 * consistent (Cloudflare docs), so it is abuse protection, not an exact counter.
 * A missing binding (misconfiguration) always blocks. If the limiter service itself
 * errors, `onError` decides: "closed" blocks; "open" lets the request through (used
 * for door scans, where D1 still decides every admission, so a limiter outage must
 * not stop the door).
 */
export async function rateLimited(binding: RateLimit | undefined, key: string, onError: "open" | "closed" = "closed"): Promise<boolean> {
  if (!binding) return true;
  try {
    const { success } = await binding.limit({ key });
    return !success;
  } catch (e) {
    console.error(JSON.stringify({ evt: "rate_limiter_error", key_kind: key.split(":")[0], on_error: onError, message: String((e as Error)?.message ?? e) }));
    return onError === "closed";
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
  // NOT "no-referrer": under that policy browsers send `Origin: null` on every POST,
  // even same-origin (Fetch standard, "append a request Origin header"), which our
  // Origin check rightly rejects. "same-origin" keeps the real Origin for our own
  // requests and still sends no referrer to any other site.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cache-control": "no-store",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** Small server-rendered page (no scripts) used after sign-in. */
export function page(title: string, bodyHtml: string, refreshTo?: string): string {
  const meta = refreshTo ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(refreshTo)}">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${meta}<title>${escapeHtml(title)}</title></head><body>
<header><a href="/">Sign in</a> | <a href="https://nova.example/" rel="noopener">Made by Nova</a></header>
<main>${bodyHtml}</main></body></html>`;
}
