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
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'; font-src 'self'",
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

/**
 * A page the Worker answers itself: sign-in results (failed, no access, choose a
 * party, signed in) and "page not found". It has the site's look: the shared
 * stylesheet and public/js/notice.js, which shows the wording by `key` in English
 * or Arabic with the usual top bar and footer. The English text inside is what
 * shows before the script runs (and what tests read).
 */
export interface Notice {
  /** Which message (public/js/notice.js: nt_<key>_t / nt_<key>). */
  key: string;
  title: string;
  text: string;
  /** A short code shown small, for example why Google refused the sign-in. */
  detail?: string;
  /** Where "try again" goes: /signin (default), /platform or /. */
  back?: string;
  backLabel?: string;
  /** Go on at once (after a successful sign-in). */
  refreshTo?: string;
  /** Already escaped HTML placed under the text (the party choice forms). */
  extraHtml?: string;
}

export function page(n: Notice): string {
  const meta = n.refreshTo ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(n.refreshTo)}">` : "";
  const back = n.back ?? "/signin";
  const detail = n.detail ? ` (${escapeHtml(n.detail)})` : "";
  const data = `data-notice="${escapeHtml(n.key)}" data-back="${escapeHtml(back)}"` + (n.detail ? ` data-detail="${escapeHtml(n.detail)}"` : "") +
    (n.refreshTo ? ` data-next="${escapeHtml(n.refreshTo)}"` : "");
  const backLink = n.refreshTo ? `<p><a href="${escapeHtml(n.refreshTo)}">Continue</a></p>` : `<p><a href="${escapeHtml(back)}">${escapeHtml(n.backLabel ?? "Back to sign in")}</a></p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
${meta}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${escapeHtml(n.title)} | Sahra</title>
<link rel="stylesheet" href="/css/sahra.css">
</head>
<body>
<main id="app" class="notice-page" ${data}>
<section class="card notice-card"><h1>${escapeHtml(n.title)}</h1><p>${escapeHtml(n.text)}${detail}</p>${n.extraHtml ?? ""}${backLink}</section>
</main>
<script src="/js/i18n.js"></script>
<script src="/js/ui.js"></script>
<script src="/js/notice.js"></script>
</body>
</html>`;
}
