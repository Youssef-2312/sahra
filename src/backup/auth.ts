// Request signatures for the backup export (src/routes/backup.ts). The caller is
// the platform owner's Google Apps Script (backup/apps-script/Code.gs); it holds
// the same secret BACKUP_KEY in its Script Properties.
//
//   string    = "SAHRA-BACKUP-1\n" + METHOD + "\n" + host + "\n" + path + "\n" + query + "\n" + time
//               (+ "\n" + hex SHA-256 of the body, for POST)
//   signature = lowercase hex HMAC-SHA256(BACKUP_KEY bytes, string)
//
// `query` is the raw query string as sent, without "?" (the client only uses
// characters that no proxy rewrites: A-Z a-z 0-9 - _ . = &). `time` is Unix
// seconds. Headers: x-sahra-backup-time, x-sahra-backup-signature.
//
// Stateless on purpose (no nonce table): a request older or newer than 5 minutes
// is refused, and inside that window a captured request can only be sent again
// to read the same page it already read. The export endpoints are GETs that write
// nothing. The one write, POST /api/backup/done, signs its body too and only
// moves "last backup" forward to the time in the signed folder name, so sending
// it again inside the window writes the same values again. A nonce table would
// cost a database write per request.
// The signature covers method, host, path and query, so a signed request for one
// page, table, file or environment (staging vs production host) is useless for
// any other.

import { b64urlDecode, hex, timingSafeEqualStr } from "../lib/crypto";

export const BACKUP_SKEW_MS = 5 * 60_000;
export const SIG_HEADER = "x-sahra-backup-signature";
export const TIME_HEADER = "x-sahra-backup-time";

const enc = new TextEncoder();
const QUERY_RE = /^[A-Za-z0-9_.=&-]*$/;

export function canonical(method: string, host: string, path: string, query: string, time: string, bodySha256?: string): string {
  const lines = ["SAHRA-BACKUP-1", method.toUpperCase(), host.toLowerCase(), path, query, time];
  if (method.toUpperCase() !== "GET") lines.push(bodySha256 ?? "");
  return lines.join("\n");
}

async function sha256hexOf(body: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
}

/** The key's bytes, or null when BACKUP_KEY is missing or shorter than 32 bytes (the endpoints then answer 503). */
export function backupKeyBytes(key: unknown): Uint8Array | null {
  if (typeof key !== "string") return null;
  const raw = b64urlDecode(key.replace(/=+$/, ""));
  return raw && raw.length >= 32 ? raw : null;
}

// One imported key per isolate (the secret changes only with a redeploy).
let cached: { raw: string; key: Promise<CryptoKey> } | null = null;

/** Hex HMAC-SHA256 of `text` under BACKUP_KEY (`raw`, already checked by backupKeyBytes). */
export async function signature(raw: string, keyBytes: Uint8Array, text: string): Promise<string> {
  if (cached?.raw !== raw) cached = { raw, key: crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) };
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", await cached.key, enc.encode(text))));
}

export type Verdict = { ok: true } | { ok: false; status: 401 | 503; error: string };

/** Checks a request's signature (`body`: the raw body of a POST). Never touches a database. */
export async function verifyBackupRequest(env: { BACKUP_KEY?: string }, req: Request, now: number, body?: Uint8Array): Promise<Verdict> {
  const keyBytes = backupKeyBytes(env.BACKUP_KEY);
  if (!keyBytes) return { ok: false, status: 503, error: "backup_not_configured" };
  const sig = req.headers.get(SIG_HEADER) ?? "";
  const time = req.headers.get(TIME_HEADER) ?? "";
  if (!/^[0-9a-f]{64}$/.test(sig) || !/^[0-9]{1,12}$/.test(time)) return { ok: false, status: 401, error: "not_signed" };
  if (Math.abs(now - Number(time) * 1000) > BACKUP_SKEW_MS) return { ok: false, status: 401, error: "stale_request" };
  const url = new URL(req.url);
  const query = url.search.replace(/^\?/, "");
  if (!QUERY_RE.test(query)) return { ok: false, status: 401, error: "bad_signature" };
  const bodyHash = req.method === "GET" ? undefined : await sha256hexOf(body ?? new Uint8Array());
  const want = await signature(env.BACKUP_KEY!, keyBytes, canonical(req.method, url.host, url.pathname, query, time, bodyHash));
  if (!timingSafeEqualStr(sig, want)) return { ok: false, status: 401, error: "bad_signature" };
  return { ok: true };
}

/** Headers for a signed request (tests and the local Apps Script simulation; Code.gs does the same). */
export async function signedHeaders(key: string, method: string, url: string, now: number, body?: string): Promise<Record<string, string>> {
  const keyBytes = backupKeyBytes(key);
  if (!keyBytes) throw new Error("BACKUP_KEY must be base64url of at least 32 bytes");
  const u = new URL(url);
  const time = String(Math.floor(now / 1000));
  const bodyHash = method.toUpperCase() === "GET" ? undefined : await sha256hexOf(enc.encode(body ?? ""));
  const sig = await signature(key, keyBytes, canonical(method, u.host, u.pathname, u.search.replace(/^\?/, ""), time, bodyHash));
  return { [TIME_HEADER]: time, [SIG_HEADER]: sig };
}
