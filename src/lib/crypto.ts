// Small crypto helpers on top of WebCrypto (available in workerd).

const enc = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A fresh 256-bit token, base64url (43 chars). */
export function newToken(): string {
  return b64url(randomBytes(32));
}

/**
 * Parses a 256-bit base64url token. Accepts only the canonical 43-character
 * encoding of exactly 32 bytes, so one value has exactly one spelling.
 */
export function parseToken(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length !== 43) return null;
  const b = b64urlDecode(s);
  if (!b || b.length !== 32 || b64url(b) !== s) return null;
  return b;
}

export function newId(): string {
  return crypto.randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

export async function sha256hex(data: string | Uint8Array): Promise<string> {
  return hex(await sha256(data));
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function hmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmac(key: CryptoKey, data: string | Uint8Array): Promise<Uint8Array> {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // workerd provides crypto.subtle.timingSafeEqual; fall back to a constant-time loop.
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

/**
 * CSRF token for a session: HMAC-SHA256 keyed by the raw session token. The
 * server can recompute it from the cookie on every request, so nothing is stored,
 * and it cannot be derived from anything stored in the database.
 */
export async function csrfFor(sessionToken: Uint8Array): Promise<string> {
  return b64url(await hmac(await hmacKey(sessionToken), "sahra-csrf-v1"));
}

// ---------------------------------------------------------------------------
// Per-party keys derived from one master secret per purpose (HKDF-SHA256).
// Master secrets live in env vars named `<PURPOSE>_MASTER_K<keyId>`, each the
// base64url encoding of at least 32 random bytes. A key id travels inside every
// QR code and ticket link, so a master can be rotated by adding K2 while K1
// keeps verifying old codes until they are retired.

export type KeyPurpose = "QR" | "LINK" | "COOKIE";

const derivedCache = new Map<string, Promise<CryptoKey>>();

export class MissingSecretError extends Error {}

export function deriveHmacKey(
  env: Record<string, unknown>,
  purpose: KeyPurpose,
  partyId: string,
  keyId: number,
): Promise<CryptoKey> {
  const name = `${purpose}_MASTER_K${keyId}`;
  const master = env[name];
  if (typeof master !== "string") return Promise.reject(new MissingSecretError(name));
  const raw = b64urlDecode(master);
  if (!raw || raw.length < 32) return Promise.reject(new MissingSecretError(`${name} must be at least 32 bytes`));
  const cacheKey = `${name}|${partyId}|${master}`;
  let p = derivedCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("sahra-hkdf-v1"), info: enc.encode(`${purpose}|${partyId}|k${keyId}`) },
        ikm,
        256,
      );
      return hmacKey(new Uint8Array(bits));
    })();
    p.catch(() => derivedCache.delete(cacheKey));
    derivedCache.set(cacheKey, p);
  }
  return p;
}

// Crockford base32 (0-9, A-Z without I, L, O, U): every character is in the QR
// alphanumeric set, so codes can use QR alphanumeric mode.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function base32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (out.length < chars && bits > 0) out += B32[(acc << (5 - bits)) & 31];
  if (out.length !== chars) throw new Error("not enough bytes for base32 length");
  return out;
}

export function isBase32(s: string, len: number): boolean {
  if (s.length !== len) return false;
  for (const ch of s) if (!B32.includes(ch)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Sealed values (AES-256-GCM), used for short-lived browser cookies that must
// carry server data (sign-in state, nonce, PKCE verifier) without any database
// write. Format: <keyId>.<iv>.<ciphertext+tag>, base64url parts. The purpose
// string is bound as additional authenticated data, so a value sealed for one
// purpose cannot be replayed as another. The payload carries its own expiry.

const aesCache = new Map<string, Promise<CryptoKey>>();

function aesKey(env: Record<string, unknown>, keyId: number): Promise<CryptoKey> {
  const name = `COOKIE_MASTER_K${keyId}`;
  const master = env[name];
  if (typeof master !== "string") return Promise.reject(new MissingSecretError(name));
  const raw = b64urlDecode(master);
  if (!raw || raw.length < 32) return Promise.reject(new MissingSecretError(`${name} must be at least 32 bytes`));
  const cacheKey = `${name}|${master}`;
  let p = aesCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("sahra-hkdf-v1"), info: enc.encode(`COOKIE|global|k${keyId}`) },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    p.catch(() => aesCache.delete(cacheKey));
    aesCache.set(cacheKey, p);
  }
  return p;
}

export function currentCookieKeyId(env: Record<string, unknown>): number {
  const v = Number(env.COOKIE_KEY_ID ?? 1);
  return Number.isInteger(v) && v >= 1 && v <= 9 ? v : 1;
}

export async function seal(env: Record<string, unknown>, purpose: string, payload: Record<string, unknown>, expiresAt: number): Promise<string> {
  const keyId = currentCookieKeyId(env);
  const iv = randomBytes(12);
  const pt = enc.encode(JSON.stringify({ ...payload, exp: expiresAt }));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`sahra-seal-v1|${purpose}`) }, await aesKey(env, keyId), pt),
  );
  return `${keyId}.${b64url(iv)}.${b64url(ct)}`;
}

/** Returns the payload, or null if the value is malformed, forged, for another purpose, or expired. */
export async function unseal(env: Record<string, unknown>, purpose: string, value: string, now: number): Promise<Record<string, unknown> | null> {
  if (value.length > 2048) return null;
  const m = /^([1-9])\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/.exec(value);
  if (!m) return null;
  const iv = b64urlDecode(m[2]!);
  const ct = b64urlDecode(m[3]!);
  if (!iv || iv.length !== 12 || !ct) return null;
  let key: CryptoKey;
  try {
    key = await aesKey(env, Number(m[1]));
  } catch (e) {
    // An unknown or retired key id is just an invalid value; a missing CURRENT key is a config error.
    if (Number(m[1]) === currentCookieKeyId(env)) throw e;
    return null;
  }
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`sahra-seal-v1|${purpose}`) }, key, ct);
    const obj = JSON.parse(new TextDecoder().decode(pt));
    if (typeof obj !== "object" || obj === null || typeof obj.exp !== "number" || obj.exp <= now) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}
