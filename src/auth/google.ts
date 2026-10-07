// Google sign-in: authorization-code flow with state, nonce and PKCE, and full
// ID token verification as described in
// https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

import { b64url, b64urlDecode, sha256, sha256hex, timingSafeEqual } from "../lib/crypto";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
export const CLOCK_SKEW_S = 60;

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await sha256(verifier));
}

export function authUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export class AuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function exchangeCode(
  fetcher: Fetcher,
  p: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    code: p.code,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uri: p.redirectUri,
    grant_type: "authorization_code",
    code_verifier: p.codeVerifier,
  });
  const res = await fetcher(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new AuthError("token_exchange_failed");
  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== "string") throw new AuthError("no_id_token");
  return json.id_token;
}

// --------------------------------------------------------------------- JWKS

interface JwksState {
  keys: Map<string, CryptoKey>;
  expiresAt: number;
  lastFetchAt: number;
  inflight: Promise<void> | null;
}

/**
 * In-memory cache of Google's signing keys (per isolate). Refreshes when the
 * cache has expired (Cache-Control max-age) or when a token names an unknown key
 * id, but never more often than once per `minRefreshMs`, so a flood of tokens
 * with made-up key ids cannot make us hammer Google.
 */
export class JwksCache {
  private s: JwksState = { keys: new Map(), expiresAt: 0, lastFetchAt: -Infinity, inflight: null };
  /** Set to "miss" whenever a request had to fetch keys (for measurement logs). */
  lastLookup: "hit" | "miss" | "none" = "none";

  constructor(
    private readonly fetcher: Fetcher,
    private readonly minRefreshMs = 60_000,
  ) {}

  private async refresh(now: number): Promise<void> {
    if (this.s.inflight) return this.s.inflight;
    this.s.lastFetchAt = now;
    this.s.inflight = (async () => {
      try {
        const res = await this.fetcher(GOOGLE_JWKS_URL);
        if (!res.ok) throw new AuthError("jwks_fetch_failed");
        const json = (await res.json()) as { keys?: JsonWebKey[] };
        const keys = new Map<string, CryptoKey>();
        for (const jwk of json.keys ?? []) {
          const kid = (jwk as JsonWebKey & { kid?: string }).kid;
          if (jwk.kty !== "RSA" || typeof kid !== "string") continue;
          if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
          const key = await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          keys.set(kid, key);
        }
        const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
        const maxAge = Math.min(Math.max(m ? Number(m[1]) : 3600, 300), 86_400);
        this.s.keys = keys;
        this.s.expiresAt = now + maxAge * 1000;
      } finally {
        this.s.inflight = null;
      }
    })();
    return this.s.inflight;
  }

  async getKey(kid: string, now: number): Promise<CryptoKey> {
    const fresh = now < this.s.expiresAt;
    const cached = this.s.keys.get(kid);
    if (fresh && cached) {
      if (this.lastLookup === "none") this.lastLookup = "hit";
      return cached;
    }
    // Expired cache: refetch (after a failed fetch, wait a few seconds first).
    // Unknown key id with a fresh cache: refetch at most once per minRefreshMs.
    const sinceFetch = now - this.s.lastFetchAt;
    const mayFetch = fresh ? sinceFetch >= this.minRefreshMs : sinceFetch >= Math.min(5_000, this.minRefreshMs);
    if (mayFetch || this.s.inflight) {
      this.lastLookup = "miss";
      await this.refresh(now);
    }
    const k = this.s.keys.get(kid);
    if (!k || now >= this.s.expiresAt) throw new AuthError("unknown_key_id");
    return k;
  }
}

// ------------------------------------------------------------ ID token check

export interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  nonce: string;
  email?: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
}

function decodeJson(part: string): Record<string, unknown> {
  const b = b64urlDecode(part);
  if (!b) throw new AuthError("malformed_token");
  try {
    const v = JSON.parse(new TextDecoder().decode(b));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new AuthError("malformed_token");
  }
}

/**
 * Verifies a Google ID token. `expectedNonceHash` is the SHA-256 (hex) of the
 * nonce issued for this sign-in attempt; the attempt row is single use, so the
 * nonce can match at most once.
 */
export async function verifyIdToken(
  token: string,
  p: { clientId: string; expectedNonceHash: string; jwks: JwksCache; nowMs: number },
): Promise<GoogleClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed_token");
  const [h, pl, sig] = parts as [string, string, string];
  const header = decodeJson(h);
  if (header.alg !== "RS256") throw new AuthError("bad_alg");
  if (typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 128) throw new AuthError("no_kid");

  const key = await p.jwks.getKey(header.kid, p.nowMs);
  const sigBytes = b64urlDecode(sig);
  if (!sigBytes) throw new AuthError("malformed_token");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, new TextEncoder().encode(`${h}.${pl}`));
  if (!ok) throw new AuthError("bad_signature");

  const c = decodeJson(pl);
  const now = Math.floor(p.nowMs / 1000);
  if (typeof c.iss !== "string" || !ISSUERS.has(c.iss)) throw new AuthError("bad_issuer");
  if (typeof c.aud !== "string" || c.aud !== p.clientId) throw new AuthError("bad_audience");
  if (c.azp !== undefined && c.azp !== p.clientId) throw new AuthError("bad_audience");
  if (typeof c.exp !== "number" || now > c.exp + CLOCK_SKEW_S) throw new AuthError("expired");
  if (typeof c.iat !== "number" || c.iat > now + CLOCK_SKEW_S) throw new AuthError("issued_in_future");
  if (typeof c.sub !== "string" || c.sub.length === 0 || c.sub.length > 255) throw new AuthError("bad_subject");
  if (typeof c.nonce !== "string") throw new AuthError("bad_nonce");
  const nonceHash = await sha256hex(c.nonce);
  if (!timingSafeEqual(new TextEncoder().encode(nonceHash), new TextEncoder().encode(p.expectedNonceHash))) {
    throw new AuthError("bad_nonce");
  }
  const ev = c.email_verified;
  return {
    iss: c.iss,
    aud: c.aud,
    sub: c.sub,
    exp: c.exp,
    iat: c.iat,
    nonce: c.nonce,
    email: typeof c.email === "string" ? c.email : undefined,
    email_verified: ev === true || ev === "true",
    hd: typeof c.hd === "string" ? c.hd : undefined,
    name: typeof c.name === "string" ? c.name : undefined,
  };
}

// ------------------------------------------------------------- email rules

/** Lowercases; for Gmail, also drops dots and +tags and maps googlemail.com to gmail.com. */
export function normalizeEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1 || e.length > 254) return null;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.split("+")[0]!.replace(/\./g, "");
    if (!local) return null;
  }
  return `${local}@${domain}`;
}

export function isGmail(normalized: string): boolean {
  return normalized.endsWith("@gmail.com");
}

/**
 * Auto-linking is allowed only when Google says the address is verified AND it is
 * a Gmail address, or the token carries an hd claim (Google Workspace) that
 * matches the address's domain.
 */
export function canAutoLink(c: GoogleClaims): boolean {
  if (c.email_verified !== true || !c.email) return false;
  const n = normalizeEmail(c.email);
  if (!n) return false;
  if (isGmail(n)) return true;
  if (c.hd && n.endsWith(`@${c.hd.toLowerCase()}`)) return true;
  return false;
}
