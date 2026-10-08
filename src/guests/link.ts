// Guest ticket links (the guest's own page: status, and the QR once released).
//
//   T1.<PARTY>.<K><TICKET>.<LINK_VERSION>.<SIGNATURE>
//
// Same shape as a QR code (src/qr.ts) but a different prefix and a different
// per-party key (HKDF purpose "LINK" from LINK_MASTER_K<K>), so a QR code is never
// a valid link and the other way round. LINK_VERSION is tickets.link_version: a
// name transfer bumps it and the previous holder's link stops working.
//
// The token travels in the URL fragment (/ticket.html#t=...), which browsers never
// send to a server, so it does not end up in request logs; the page sends it to
// the API in a request header. The signature is checked before any database access.

import { MissingSecretError, base32, deriveHmacKey, hmac, isBase32, timingSafeEqualStr } from "../lib/crypto";

export interface LinkPayload {
  partyId: string;
  keyId: number;
  ticketId: string;
  version: number;
}

const LINK_RE = /^T1\.([A-Z0-9-]{3,24})\.([1-9])([0-9A-Z]{16})\.([1-9][0-9]{0,5})\.([0-9A-Z]{26})$/;

export function currentLinkKeyId(env: Record<string, unknown>): number {
  const v = Number(env.LINK_KEY_ID ?? 1);
  return Number.isInteger(v) && v >= 1 && v <= 9 ? v : 1;
}

function body(p: LinkPayload): string {
  return `T1.${p.partyId.toUpperCase()}.${p.keyId}${p.ticketId}.${p.version}`;
}

export async function signLink(env: Record<string, unknown>, p: Omit<LinkPayload, "keyId">): Promise<string> {
  const full: LinkPayload = { ...p, keyId: currentLinkKeyId(env) };
  const b = body(full);
  const key = await deriveHmacKey(env, "LINK", full.partyId, full.keyId);
  return `${b}.${base32(await hmac(key, b), 26)}`;
}

/** Path of the guest's ticket page for a token (the token stays in the fragment). */
export function linkPath(token: string): string {
  return `/ticket.html#t=${token}`;
}

/** Returns the payload only for a well-formed, correctly signed link; otherwise null. */
export async function verifyLink(env: Record<string, unknown>, text: unknown): Promise<LinkPayload | null> {
  if (typeof text !== "string" || text.length > 96) return null;
  const m = LINK_RE.exec(text.trim());
  if (!m) return null;
  const [, party, kid, ticketId, ver, sig] = m as unknown as [string, string, string, string, string, string];
  if (!isBase32(ticketId, 16) || !isBase32(sig, 26)) return null;
  const p: LinkPayload = { partyId: party.toLowerCase(), keyId: Number(kid), ticketId, version: Number(ver) };
  let key: CryptoKey;
  try {
    key = await deriveHmacKey(env, "LINK", p.partyId, p.keyId);
  } catch (e) {
    // A retired or unknown key id is just an invalid link; a missing CURRENT key is a config error.
    if (e instanceof MissingSecretError && p.keyId !== currentLinkKeyId(env)) return null;
    throw e;
  }
  const expected = base32(await hmac(key, body(p)), 26);
  return timingSafeEqualStr(expected, sig) ? p : null;
}
